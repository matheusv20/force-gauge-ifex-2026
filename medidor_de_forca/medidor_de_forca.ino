/*
 * ============================================================================
 * PROJETO INTERDISCIPLINAR — MEDIDOR DE FORÇA (HIGH STRIKER)
 * Código Oficial Integrado (Sensores + Atuadores + Site de Ranking Ao Vivo)
 * ============================================================================
 *
 * Mapa Oficial de Pinos (Arduino Uno):
 *   D2 (INT0) -> TCRT5000 #1 DO (Sensor óptico superior - S1)
 *   D3 (INT1) -> TCRT5000 #2 DO (Sensor óptico inferior - S2)
 *   D4        -> HX711 DT       (Dados da célula de carga - 4x 50kg)
 *   D5        -> HX711 SCK      (Clock da célula de carga)
 *   D7        -> PIR HC-SR501   (Sensor de presença do jogador)
 *   D8        -> Buzzer         (Atuador sonoro)
 *   D9        -> HC-SR04 Trig   (Opcional: ultrassônico superior)
 *   D10       -> HC-SR04 Echo   (Opcional: ultrassônico superior)
 *   A4 (SDA)  -> LCD 16x2 I2C   (Endereço 0x27 ou 0x3F)
 *   A5 (SCL)  -> LCD 16x2 I2C
 *
 * Comunicação Serial (115200 baud):
 *   Comandos recebidos do PC:
 *     START:<Nome>  -> Inicia rodada para o participante <Nome>
 *     RESET         -> Cancela rodada e volta ao repouso (IDLE)
 *     TARE          -> Refaz a tara (zero) da célula de carga HX711
 *     STATUS        -> Imprime diagnóstico completo de todos os sensores
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "HX711.h"

// --------------------- PINOS ---------------------
const uint8_t PINO_S1_TCRT  = 2;   // INT0 - TCRT5000 superior (ativo LOW)
const uint8_t PINO_S2_TCRT  = 3;   // INT1 - TCRT5000 inferior (ativo LOW)
const uint8_t PINO_HX_DT    = 4;   // HX711 DT
const uint8_t PINO_HX_SCK   = 5;   // HX711 SCK
const uint8_t PINO_PIR      = 7;   // PIR HC-SR501 OUT (ativo HIGH)
const uint8_t PINO_BUZZER   = 8;   // Buzzer (+) oficial em D8
const uint8_t PINO_BUZZER_ALT1 = 6; // Espelho em D6 (caso o jumper do buzzer esteja no pino vizinho)
const uint8_t PINO_TRIG     = 9;   // HC-SR04 Trig (opcional / espelho em D9 se sem ultrassônico)
const uint8_t PINO_ECHO     = 10;  // HC-SR04 Echo (opcional)

// --------------------- PARÂMETROS FÍSICOS E CALIBRAÇÃO ---------------------
// Distância vertical entre o sensor S1 (D2) e o sensor S2 (D3) em centímetros:
const float DIST_SENSORES_CM        = 15.0f;
// Largura efetiva da cabeça da marreta (cm) caso apenas 1 sensor óptico dispare:
const float LARGURA_MARRETA_CM      = 4.5f;
// Fator de calibração dinâmica da célula de carga (unidades brutas por kgf de pico de impacto):
const float FATOR_CALIBRACAO_HX     = 600.0f;
// Referência de impacto forte com as 2 mãos (~11.000 bruto = ~917 pts; 12.000 bruto = 1000 pts):
const float FORCA_BRUTA_MAX_SCORE   = 12000.0f;
// Peso da tábua de MDF (755 gramas = 0.755 kg) apoiada sobre as células de carga:
const float PESO_TABUA_KGF          = 0.755f;
const long  PESO_TABUA_BRUTO        = 450L;
// Limiar mínimo de variação bruta acima da base imediata para considerar impacto:
const long  LIMIAR_IMPACTO_BRUTO    = 3800L;
// Salto mínimo instantâneo entre duas amostras consecutivas (100ms) para filtrar deriva lenta:
const long  LIMIAR_SALTO_AMOSTRA    = 2600L;
// Zona morta de ruído/repouso descontada do pico bruto para que pancadas fracas pontuem baixo (50-250 pts):
const long  ZONA_MORTA_IMPACTO      = 3000L;
// Limite superior anti-ruído (descarta leituras corrompidas por mau contato > 60.000):
const long  LIMITE_GLITCH_BRUTO     = 60000L;
// Tempo máximo exibindo "JOGADOR DETECTADO" antes de voltar automaticamente para "Em repouso" (ms):
const unsigned long RETENCAO_PIR_MS = 8000UL;
// Tempo da janela de captura do pico de impacto após detectar marreta (ms):
const unsigned long JANELA_IMPACTO_MS = 380UL;
// Tempo exibindo o resultado no LCD antes de voltar ao repouso (ms):
const unsigned long TEMPO_RESULTADO_MS = 8000UL;

// --------------------- OBJETOS GLOBAIS ---------------------
LiquidCrystal_I2C lcd(0x27, 16, 2);
HX711 balanca;

bool lcdDisponivel = false;
bool lcdInvertido  = false; // true se SDA=A5 e SCL=A4
uint8_t lcdAddr    = 0x27;
uint8_t pinoSda    = A4;
uint8_t pinoScl    = A5;
bool hxDisponivel  = false;
long taraHx        = 0;
long ultBrutoHx    = 0;

// --- Driver I2C Tolerante a Inversão (funciona com SDA=A4/SCL=A5 OU SDA=A5/SCL=A4) ---
void swI2cDelay() { delayMicroseconds(6); }
void sdaHigh() { pinMode(pinoSda, INPUT_PULLUP); }
void sdaLow()  { pinMode(pinoSda, OUTPUT); digitalWrite(pinoSda, LOW); }
void sclHigh() { pinMode(pinoScl, INPUT_PULLUP); }
void sclLow()  { pinMode(pinoScl, OUTPUT); digitalWrite(pinoScl, LOW); }

void swI2cStart() {
  sdaHigh(); sclHigh(); swI2cDelay();
  sdaLow();  swI2cDelay();
  sclLow();  swI2cDelay();
}

void swI2cStop() {
  sdaLow();  swI2cDelay();
  sclHigh(); swI2cDelay();
  sdaHigh(); swI2cDelay();
}

bool swI2cWriteByte(uint8_t b) {
  for (uint8_t i = 0; i < 8; i++) {
    if (b & 0x80) sdaHigh(); else sdaLow();
    swI2cDelay();
    sclHigh(); swI2cDelay();
    sclLow();  swI2cDelay();
    b <<= 1;
  }
  sdaHigh(); swI2cDelay();
  sclHigh(); swI2cDelay();
  bool ack = (digitalRead(pinoSda) == LOW);
  sclLow();  swI2cDelay();
  return ack;
}

bool swI2cWritePcf(uint8_t data) {
  swI2cStart();
  if (!swI2cWriteByte(lcdAddr << 1)) {
    swI2cStop();
    return false;
  }
  swI2cWriteByte(data | 0x08); // 0x08 = Backlight ON
  swI2cStop();
  return true;
}

void lcdPulsoEnable(uint8_t val) {
  swI2cWritePcf(val | 0x04);
  delayMicroseconds(2);
  swI2cWritePcf(val & ~0x04);
  delayMicroseconds(50);
}

void lcdEnviarByte(uint8_t val, uint8_t modoRs) {
  uint8_t hi = (val & 0xF0) | modoRs | 0x08;
  uint8_t lo = ((val << 4) & 0xF0) | modoRs | 0x08;
  lcdPulsoEnable(hi);
  lcdPulsoEnable(lo);
}

void lcdInicializarHardware() {
  delay(50);
  swI2cWritePcf(0x08);
  delay(10);
  lcdPulsoEnable(0x30); delayMicroseconds(4500);
  lcdPulsoEnable(0x30); delayMicroseconds(4500);
  lcdPulsoEnable(0x30); delayMicroseconds(150);
  lcdPulsoEnable(0x20); delayMicroseconds(150);
  lcdEnviarByte(0x28, 0); // 4-bit, 2 linhas, 5x8
  lcdEnviarByte(0x0C, 0); // Display ON, Cursor OFF
  lcdEnviarByte(0x06, 0); // Entry mode
  lcdEnviarByte(0x01, 0); // Clear
  delay(3);
}

bool detectarEInicializarLcd() {
  TWCR = 0; // Desativa TWI de hardware para permitir uso livre de A4/A5 em qualquer ordem
  const uint8_t pares[2][2] = {{A4, A5}, {A5, A4}};
  const uint8_t enderecos[2] = {0x27, 0x3F};

  for (uint8_t p = 0; p < 2; p++) {
    pinoSda = pares[p][0];
    pinoScl = pares[p][1];
    // Destrava barramento I2C com 9 pulsos de clock
    sdaHigh();
    for (uint8_t k = 0; k < 9; k++) {
      sclLow(); swI2cDelay();
      sclHigh(); swI2cDelay();
    }
    swI2cStop();

    for (uint8_t a = 0; a < 2; a++) {
      lcdAddr = enderecos[a];
      swI2cStart();
      bool ok = swI2cWriteByte(lcdAddr << 1);
      swI2cStop();
      if (ok) {
        lcdInvertido = (p == 1);
        lcdDisponivel = true;
        lcdInicializarHardware();
        return true;
      }
    }
  }
  lcdDisponivel = false;
  return false;
}

// --------------------- INTERRUPÇÕES DOS SENSORES ÓPTICOS ---------------------
volatile unsigned long tS1_us = 0;
volatile unsigned long tS1_fim_us = 0;
volatile unsigned long tS2_us = 0;
volatile unsigned long tS2_fim_us = 0;
volatile bool s1Disparou = false;
volatile bool s2Disparou = false;

void isrS1() {
  unsigned long agora = micros();
  if (!s1Disparou) {
    tS1_us = agora;
    s1Disparou = true;
  } else if (tS1_fim_us == 0 && (agora - tS1_us > 1500UL)) {
    tS1_fim_us = agora;
  }
}

void isrS2() {
  unsigned long agora = micros();
  if (!s2Disparou) {
    tS2_us = agora;
    s2Disparou = true;
  } else if (tS2_fim_us == 0 && (agora - tS2_us > 1500UL)) {
    tS2_fim_us = agora;
  }
}

void zerarCronografo() {
  noInterrupts();
  tS1_us = 0;
  tS1_fim_us = 0;
  tS2_us = 0;
  tS2_fim_us = 0;
  s1Disparou = false;
  s2Disparou = false;
  interrupts();
}

// --------------------- MÁQUINA DE ESTADOS ---------------------
enum EstadoMaquina {
  ESTADO_IDLE = 0,
  ESTADO_PLAYER_DETECTED,
  ESTADO_COUNTDOWN,
  ESTADO_READY,
  ESTADO_RESULTADO
};

EstadoMaquina estadoAtual = ESTADO_IDLE;
char nomeJogador[17] = "Jogador";
unsigned long ultimoMovimentoPirMs = 0;
unsigned long inicioEstadoMs = 0;
unsigned long pausaPirAteMs = 0;
bool aguardarPirBaixo = false;
uint8_t etapaContagem = 0;

// --------------------- FUNÇÕES AUXILIARES DE SOM E LCD ---------------------
// Aciona tanto buzzer passivo (onda quadrada) quanto buzzer ativo (nível DC HIGH) em D8 (e D6/D9):
void tocarBip(uint16_t freq, uint16_t durMs) {
  pinMode(PINO_BUZZER, OUTPUT);
  pinMode(PINO_BUZZER_ALT1, OUTPUT);
  pinMode(PINO_TRIG, OUTPUT);

  uint16_t metade = durMs / 2;
  unsigned long t0 = millis();
  unsigned long meioPeriodoUs = (freq > 0) ? (500000UL / freq) : 250UL;
  while (millis() - t0 < metade) {
    digitalWrite(PINO_BUZZER, HIGH);
    digitalWrite(PINO_BUZZER_ALT1, HIGH);
    digitalWrite(PINO_TRIG, HIGH);
    delayMicroseconds(meioPeriodoUs);
    digitalWrite(PINO_BUZZER, LOW);
    digitalWrite(PINO_BUZZER_ALT1, LOW);
    digitalWrite(PINO_TRIG, LOW);
    delayMicroseconds(meioPeriodoUs);
  }
  digitalWrite(PINO_BUZZER, HIGH);
  digitalWrite(PINO_BUZZER_ALT1, HIGH);
  digitalWrite(PINO_TRIG, HIGH);
  delay(durMs - metade);
  digitalWrite(PINO_BUZZER, LOW);
  digitalWrite(PINO_BUZZER_ALT1, LOW);
  digitalWrite(PINO_TRIG, LOW);
}

void bipCurto() {
  tocarBip(1800, 110);
}

void somContagem(uint8_t seg) {
  // Bipe forte para cada segundo da contagem regressiva (3, 2, 1)
  tocarBip(1200 + (3 - seg) * 150, 200);
}

void somValendo() {
  // Toque longo e agudo liberando a pancada ("JÁ / VALENDO!")
  tocarBip(2400, 420);
}

void somResultado(int score) {
  if (score >= 800) {
    tocarBip(1047, 130); delay(40);
    tocarBip(1319, 130); delay(40);
    tocarBip(1568, 130); delay(40);
    tocarBip(2093, 360);
  } else {
    tocarBip(880, 140); delay(40);
    tocarBip(1319, 240);
  }
}

void ressincronizarLcd4Bit() {
  // Ressincroniza o modo 4-bit caso a vibração da pancada tenha deslocado 1 nibble nos fios do LCD:
  lcdPulsoEnable(0x30); delayMicroseconds(4200);
  lcdPulsoEnable(0x30); delayMicroseconds(200);
  lcdPulsoEnable(0x30); delayMicroseconds(200);
  lcdPulsoEnable(0x20); delayMicroseconds(200);
  lcdEnviarByte(0x28, 0); // 4-bit, 2 linhas, 5x8
  lcdEnviarByte(0x0C, 0); // Display ON, Cursor OFF
  lcdEnviarByte(0x06, 0); // Entry mode
}

char ultimaLinha1[17] = "Medidor de Forca";
char ultimaLinha2[17] = "Em repouso...   ";

void escreverLcd(const char* l1, const char* l2) {
  snprintf(ultimaLinha1, sizeof(ultimaLinha1), "%-16.16s", l1 ? l1 : "");
  snprintf(ultimaLinha2, sizeof(ultimaLinha2), "%-16.16s", l2 ? l2 : "");
  if (!lcdDisponivel) {
    if (!detectarEInicializarLcd()) return;
  }
  if (!swI2cWritePcf(0x08)) {
    // Fio do LCD deu mau contato: tenta redetectar na hora
    if (!detectarEInicializarLcd()) return;
  }
  ressincronizarLcd4Bit();
  lcdEnviarByte(0x80, 0); // Linha 0, Coluna 0
  for (uint8_t i = 0; i < 16; i++) lcdEnviarByte((uint8_t)ultimaLinha1[i], 1);
  lcdEnviarByte(0xC0, 0); // Linha 1, Coluna 0
  for (uint8_t i = 0; i < 16; i++) lcdEnviarByte((uint8_t)ultimaLinha2[i], 1);
}

void enviarStatusJson(const char* stateStr, const char* playerStr, const char* msgStr) {
  Serial.print(F("{\"event\":\"status\",\"state\":\""));
  Serial.print(stateStr);
  Serial.print(F("\",\"player\":\""));
  Serial.print(playerStr);
  Serial.print(F("\",\"message\":\""));
  Serial.print(msgStr);
  Serial.println(F("\"}"));
}

void enviarContagemJson(uint8_t seg, const char* playerStr, const char* msgStr) {
  Serial.print(F("{\"event\":\"status\",\"state\":\"COUNTDOWN\",\"countdown\":"));
  Serial.print(seg);
  Serial.print(F(",\"player\":\""));
  Serial.print(playerStr);
  Serial.print(F("\",\"message\":\""));
  Serial.print(msgStr);
  Serial.println(F("\"}"));
}
// Lê 24 bits do HX711 com checagem dupla de DT=LOW e interrupções desativadas:
long lerHx711Seguro() {
  if (digitalRead(PINO_HX_DT) != LOW) return 0L;
  delayMicroseconds(15);
  if (digitalRead(PINO_HX_DT) != LOW) return 0L;
  noInterrupts();
  long v = (long)balanca.read();
  interrupts();
  return v;
}

// Remove somas binárias espúrias (8192, 16384, 32768) quando o fio do HX711 vibra em 1 amostra isolada:
long filtrarBitFlipIsolado(long pico1, long pico2) {
  long diff = pico1 - pico2;
  if (diff >= 28000L && pico1 >= 32768L) pico1 -= 32768L;
  diff = pico1 - pico2;
  if (diff >= 13500L && pico1 >= 16384L) pico1 -= 16384L;
  diff = pico1 - pico2;
  if (diff >= 6800L && pico1 >= 8192L) pico1 -= 8192L;
  // Limita espículas isoladas de 1 amostra para não inflar batidas fracas:
  long tetoValidado = pico2 + 4200L;
  if (pico1 > tetoValidado) {
    pico1 = (pico1 + tetoValidado) / 2L;
  }
  return pico1;
}

bool leituraHxValida(long v) {
  if (v == -1L || v == 0L || v == 8388607L || v == -8388608L) return false;
  return true;
}

bool verificarHx711() {
  if (!balanca.wait_ready_timeout(250)) {
    hxDisponivel = false;
    return false;
  }
  long v = lerHx711Seguro();
  if (!leituraHxValida(v)) {
    hxDisponivel = false;
    return false;
  }
  hxDisponivel = true;
  return true;
}

void realizarTara() {
  if (!verificarHx711()) {
    Serial.println(F("[AVISO] HX711 nao respondeu com leitura valida na tara (verifique 5V/GND e D4/D5)."));
    return;
  }
  // Lê 5 amostras e usa a mediana/média filtrada para ignorar qualquer glitch
  long leituras[5];
  uint8_t cont = 0;
  for (uint8_t i = 0; i < 7 && cont < 5; i++) {
    if (balanca.wait_ready_timeout(150)) {
      long v = lerHx711Seguro();
      if (leituraHxValida(v)) {
        leituras[cont++] = v;
      }
    }
  }
  if (cont > 0) {
    // Ordena para pegar a mediana (imune a picos isolados)
    for (uint8_t i = 0; i < cont - 1; i++) {
      for (uint8_t j = i + 1; j < cont; j++) {
        if (leituras[j] < leituras[i]) {
          long tmp = leituras[i];
          leituras[i] = leituras[j];
          leituras[j] = tmp;
        }
      }
    }
    taraHx = leituras[cont / 2];
    hxDisponivel = true;
    Serial.print(F("[HX711] Tara concluida com sucesso! Offset = "));
    Serial.println(taraHx);
  }
}

// --------------------- DIAGNÓSTICO DE BANCADA ---------------------
const char* diagnosticarPino(uint8_t p) {
  pinMode(p, INPUT_PULLUP);
  delayMicroseconds(50);
  int comPullup = digitalRead(p);
  if (comPullup == LOW) {
    return "CONECTADO -> LOW (0V / Ativo)";
  }
  pinMode(p, OUTPUT);
  digitalWrite(p, LOW);
  delayMicroseconds(5);
  pinMode(p, INPUT);
  delayMicroseconds(50);
  int semPullup = digitalRead(p);
  pinMode(p, INPUT_PULLUP);
  if (semPullup == HIGH) {
    return "CONECTADO -> HIGH (5V / Livre)";
  }
  return "FLUTUANDO (desconectado ou sem 5V/GND)";
}

bool pinoTemCargaGnd(uint8_t p) {
  pinMode(p, OUTPUT);
  digitalWrite(p, HIGH);
  delayMicroseconds(10);
  pinMode(p, INPUT);
  delayMicroseconds(80);
  int v = digitalRead(p);
  pinMode(p, OUTPUT);
  digitalWrite(p, LOW);
  return (v == LOW);
}

void imprimirDiagnosticoCompleto() {
  Serial.println(F("=== DIAGNOSTICO DO PROJETO MEDIDOR DE FORCA ==="));
  Serial.print(F("  [D2] TCRT5000 #1 (Cima):  "));
  Serial.println(diagnosticarPino(PINO_S1_TCRT));
  Serial.print(F("  [D3] TCRT5000 #2 (Baixo): "));
  Serial.println(diagnosticarPino(PINO_S2_TCRT));
  Serial.print(F("  [D7] PIR HC-SR501:        "));
  Serial.println(diagnosticarPino(PINO_PIR));
  pinMode(PINO_PIR, OUTPUT);
  digitalWrite(PINO_PIR, LOW);
  delayMicroseconds(10);
  pinMode(PINO_PIR, INPUT); // PIR não deve usar pullup para não mascarar nível LOW

  Serial.print(F("  [D8] Buzzer (e D6/D9):    D8="));
  Serial.print(pinoTemCargaGnd(PINO_BUZZER) ? F("CONECTADO(GND)") : F("ABERTO"));
  Serial.print(F(" | D6="));
  Serial.print(pinoTemCargaGnd(PINO_BUZZER_ALT1) ? F("CONECTADO(GND)") : F("ABERTO"));
  Serial.print(F(" | D9="));
  Serial.println(pinoTemCargaGnd(PINO_TRIG) ? F("CONECTADO(GND)") : F("ABERTO"));

  // Verificar LCD I2C (aceita tanto SDA=A4/SCL=A5 quanto SDA=A5/SCL=A4)
  TWCR = 0;
  Serial.print(F("  [A0..A5] Teste Eletrico:  A0="));
  Serial.print(diagnosticarPino(A0)[0]);
  Serial.print(F(" A1="));
  Serial.print(diagnosticarPino(A1)[0]);
  Serial.print(F(" A2="));
  Serial.print(diagnosticarPino(A2)[0]);
  Serial.print(F(" A3="));
  Serial.print(diagnosticarPino(A3)[0]);
  Serial.print(F(" A4="));
  Serial.print(diagnosticarPino(A4));
  Serial.print(F(" | A5="));
  Serial.println(diagnosticarPino(A5));
  Serial.print(F("  [A4/A5] LCD 16x2 I2C:     "));
  if (detectarEInicializarLcd()) {
    Serial.print(F("CONECTADO em 0x"));
    Serial.print(lcdAddr, HEX);
    Serial.println(lcdInvertido ? F(" (OK! Modo SDA=A5, SCL=A4)") : F(" (OK! Modo SDA=A4, SCL=A5)"));
    escreverLcd(ultimaLinha1, ultimaLinha2);
  } else {
    Serial.println(F("NAO RESPONDEU no I2C (verifique 5V/GND e A4/A5)"));
  }

  // Verificar HX711
  Serial.print(F("  [D4/D5] HX711 Cel. Carga: "));
  if (balanca.wait_ready_timeout(250)) {
    long bruto = lerHx711Seguro();
    if (!leituraHxValida(bruto)) {
      Serial.print(F("LEITURA INVALIDA ("));
      Serial.print(bruto);
      Serial.println(F(") -> Pino D4 flutuando ou HX711 sem 5V/GND"));
      hxDisponivel = false;
    } else {
      Serial.print(F("CONECTADO! Bruto = "));
      Serial.print(bruto);
      Serial.print(F(" | Delta = "));
      Serial.println(bruto - taraHx);
      hxDisponivel = true;
    }
  } else {
    Serial.println(F("SEM RESPOSTA (DT em HIGH constante)"));
    hxDisponivel = false;
  }

  Serial.println(F("==============================================="));
}

// --------------------- TRANSIÇÕES DE ESTADO ---------------------
void irParaIdle() {
  estadoAtual = ESTADO_IDLE;
  inicioEstadoMs = millis();
  aguardarPirBaixo = true;
  pausaPirAteMs = millis() + 5000UL;
  escreverLcd("Medidor de Forca", "Em repouso...");
  enviarStatusJson("IDLE", "", "Em repouso");
}

void irParaPlayerDetected() {
  estadoAtual = ESTADO_PLAYER_DETECTED;
  inicioEstadoMs = millis();
  ultimoMovimentoPirMs = millis();
  bipCurto();
  escreverLcd("JOGADOR DETECT.!", "Procure o resp.!");
  enviarStatusJson("PLAYER_DETECTED", "", "Jogador detectado pelo sensor PIR");
}

void iniciarContagemRegressiva(const char* nome) {
  strncpy(nomeJogador, nome, 15);
  nomeJogador[15] = '\0';

  // Atualiza a tara em repouso antes de iniciar a contagem (mediana de 3 leituras sem interrupção):
  if (hxDisponivel) {
    long am[3];
    uint8_t n = 0;
    for (uint8_t i = 0; i < 4 && n < 3; i++) {
      if (balanca.wait_ready_timeout(120)) {
        long v = lerHx711Seguro();
        if (leituraHxValida(v)) {
          am[n++] = v;
        }
      }
    }
    if (n == 3) {
      if (am[1] < am[0]) { long t = am[0]; am[0] = am[1]; am[1] = t; }
      if (am[2] < am[1]) { long t = am[1]; am[1] = am[2]; am[2] = t; }
      if (am[1] < am[0]) { long t = am[0]; am[0] = am[1]; am[1] = t; }
      taraHx = am[1];
    } else if (n > 0) {
      taraHx = am[0];
    }
    Serial.print(F("[HX711] Tara da rodada (descontando tabua de 755g) = "));
    Serial.println(taraHx);
  }

  estadoAtual = ESTADO_COUNTDOWN;
  inicioEstadoMs = millis();
  etapaContagem = 3;

  char linha1[17];
  snprintf(linha1, sizeof(linha1), "Vez:%-12.12s", nomeJogador);
  escreverLcd(linha1, "Prepare-se: 3...");
  enviarContagemJson(3, nomeJogador, "Prepare-se: 3...");
  somContagem(3);
}

void entrarEmReadyValendo() {
  char linha1[17];
  snprintf(linha1, sizeof(linha1), "Vez:%-12.12s", nomeJogador);
  escreverLcd(linha1, "VALENDO! BATA!  ");
  enviarStatusJson("READY", nomeJogador, "VALENDO! Pode bater!");
  somValendo();
  // Atualiza a tara no exato instante em que "VALENDO!" começa (após o jogador erguer a marreta):
  if (hxDisponivel && balanca.wait_ready_timeout(110)) {
    long b = lerHx711Seguro();
    if (leituraHxValida(b)) {
      taraHx = b;
      ultBrutoHx = b;
    }
  }
  estadoAtual = ESTADO_READY;
  inicioEstadoMs = millis();
  zerarCronografo();
}

// --------------------- PROCESSAMENTO DE COMANDOS SERIAIS ---------------------
void processarComandoSerial(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("START:")) {
    String nome = cmd.substring(6);
    nome.trim();
    if (nome.length() == 0) nome = "Jogador";
    iniciarContagemRegressiva(nome.c_str());
  } else if (cmd.equalsIgnoreCase("RESET")) {
    pausaPirAteMs = millis() + 8000UL;
    aguardarPirBaixo = true;
    tocarBip(600, 140);
    irParaIdle();
  } else if (cmd.equalsIgnoreCase("TARE")) {
    realizarTara();
    enviarStatusJson(
      estadoAtual == ESTADO_READY ? "READY" :
      (estadoAtual == ESTADO_COUNTDOWN ? "COUNTDOWN" :
      (estadoAtual == ESTADO_PLAYER_DETECTED ? "PLAYER_DETECTED" : "IDLE")),
      (estadoAtual == ESTADO_READY || estadoAtual == ESTADO_COUNTDOWN) ? nomeJogador : "",
      "Tara da celula de carga atualizada"
    );
  } else if (cmd.equalsIgnoreCase("STATUS") || cmd.equalsIgnoreCase("E")) {
    imprimirDiagnosticoCompleto();
  }
}

// --------------------- SETUP ---------------------
void setup() {
  Serial.begin(115200);

  pinMode(PINO_S1_TCRT, INPUT_PULLUP);
  pinMode(PINO_S2_TCRT, INPUT_PULLUP);
  pinMode(PINO_PIR, INPUT);
  pinMode(PINO_BUZZER, OUTPUT);
  pinMode(PINO_BUZZER_ALT1, OUTPUT);
  pinMode(PINO_TRIG, OUTPUT);

  if (detectarEInicializarLcd()) {
    escreverLcd("Medidor de Forca", "Inicializando...");
  }

  balanca.begin(PINO_HX_DT, PINO_HX_SCK, true, false);
  delay(450); // Aguarda o primeiro ciclo de power-up do HX711
  realizarTara();
  ultBrutoHx = taraHx;

  imprimirDiagnosticoCompleto();

  attachInterrupt(digitalPinToInterrupt(PINO_S1_TCRT), isrS1, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PINO_S2_TCRT), isrS2, CHANGE);

  bipCurto();
  irParaIdle();
  // Permite apenas a 1ª detecção ao ligar caso alguém se aproxime:
  aguardarPirBaixo = false;
  pausaPirAteMs = millis() + 1500UL;
}

// --------------------- LOOP PRINCIPAL ---------------------
void loop() {
  // 1. Ler comandos da porta Serial (vindos do site_ranking ou do terminal)
  while (Serial.available()) {
    String linha = Serial.readStringUntil('\n');
    processarComandoSerial(linha);
  }

  // Se o LCD estava desconectado ou sofreu vibração da pancada, reconecta/ressincroniza automaticamente:
  static unsigned long tTentaLcd = 0;
  if (millis() - tTentaLcd >= 2500UL && estadoAtual != ESTADO_READY && estadoAtual != ESTADO_COUNTDOWN) {
    tTentaLcd = millis();
    if (!lcdDisponivel) {
      if (detectarEInicializarLcd()) {
        Serial.println(F("[LCD] Detectado e inicializado automaticamente!"));
        escreverLcd(ultimaLinha1, ultimaLinha2);
      }
    } else {
      escreverLcd(ultimaLinha1, ultimaLinha2);
    }
  }

  // 2. Monitorar mudanças físicas de bancada (para debug imediato no console)
  static int ultS1 = HIGH, ultS2 = HIGH, ultPir = LOW;
  int s1Atual = digitalRead(PINO_S1_TCRT);
  int s2Atual = digitalRead(PINO_S2_TCRT);
  int pirAtual = digitalRead(PINO_PIR);

  if (s1Atual != ultS1) {
    Serial.print(F("[SENSOR] S1 (D2) -> "));
    Serial.println(s1Atual == LOW ? F("ATIVADO (LOW)") : F("LIVRE (HIGH)"));
    ultS1 = s1Atual;
  }
  if (s2Atual != ultS2) {
    Serial.print(F("[SENSOR] S2 (D3) -> "));
    Serial.println(s2Atual == LOW ? F("ATIVADO (LOW)") : F("LIVRE (HIGH)"));
    ultS2 = s2Atual;
  }
  if (pirAtual != ultPir) {
    Serial.print(F("[SENSOR] PIR (D7) -> "));
    Serial.println(pirAtual == HIGH ? F("PRESENCA DETECTADA (HIGH)") : F("LOW"));
    ultPir = pirAtual;
  }

  // 3. Ler célula de carga HX711 continuamente quando disponível (com proteção de interrupção e filtro anti-drift)
  long deltaHxAtual = 0;
  if (hxDisponivel && balanca.is_ready()) {
    long bruto = lerHx711Seguro();
    if (leituraHxValida(bruto)) {
      long d = labs(bruto - taraHx);
      long salto = (ultBrutoHx != 0) ? labs(bruto - ultBrutoHx) : 0L;
      ultBrutoHx = bruto;

      if (d > LIMITE_GLITCH_BRUTO) {
        // Descarta pico elétrico absurdo (> 60k, ex. bit-shift de 2^18 = 262144)
        deltaHxAtual = 0;
      } else if (estadoAtual != ESTADO_READY) {
        // Fora de READY (IDLE, PLAYER_DETECTED, COUNTDOWN, RESULTADO), acompanha continuamente a base de repouso:
        taraHx = (taraHx + bruto) / 2L;
        deltaHxAtual = 0;
      } else if (d < LIMIAR_IMPACTO_BRUTO || salto < LIMIAR_SALTO_AMOSTRA) {
        // Em READY, se a variação foi lenta (sem salto brusco entre amostras), continua ajustando a tara:
        taraHx = (taraHx + bruto) / 2L;
        deltaHxAtual = 0;
      } else {
        deltaHxAtual = d;
      }
    }
  }

  // 4. Lógica da Máquina de Estados
  unsigned long agoraMs = millis();

  if (estadoAtual == ESTADO_IDLE) {
    if (pirAtual == LOW) {
      aguardarPirBaixo = false;
    }
    if (pirAtual == HIGH && !aguardarPirBaixo && (long)(agoraMs - pausaPirAteMs) >= 0) {
      irParaPlayerDetected();
    }
  }
  else if (estadoAtual == ESTADO_PLAYER_DETECTED) {
    // Volta ao repouso automaticamente após RETENCAO_PIR_MS (8s), mesmo que o PIR permaneça em HIGH,
    // ou após 3s se o PIR já tiver caído para LOW:
    bool expirouJanela = (agoraMs - inicioEstadoMs >= RETENCAO_PIR_MS);
    bool pirCaiu = (pirAtual == LOW) && (agoraMs - inicioEstadoMs >= 3000UL);
    if (expirouJanela || pirCaiu) {
      irParaIdle();
    }
  }
  else if (estadoAtual == ESTADO_COUNTDOWN) {
    unsigned long decorrido = agoraMs - inicioEstadoMs;
    char linha1[17];
    snprintf(linha1, sizeof(linha1), "Vez:%-12.12s", nomeJogador);

    if (etapaContagem == 3 && decorrido >= 1000UL) {
      etapaContagem = 2;
      escreverLcd(linha1, "Prepare-se: 2...");
      enviarContagemJson(2, nomeJogador, "Prepare-se: 2...");
      somContagem(2);
    } else if (etapaContagem == 2 && decorrido >= 2000UL) {
      etapaContagem = 1;
      escreverLcd(linha1, "Prepare-se: 1...");
      enviarContagemJson(1, nomeJogador, "Prepare-se: 1...");
      somContagem(1);
    } else if (etapaContagem == 1 && decorrido >= 3000UL) {
      entrarEmReadyValendo();
    }
  }
  else if (estadoAtual == ESTADO_READY) {
    // Dispara a medição do golpe SOMENTE quando houver salto brusco real na célula de carga
    bool houveImpactoForca = (agoraMs - inicioEstadoMs >= 80UL) && (deltaHxAtual >= LIMIAR_IMPACTO_BRUTO);

    if (houveImpactoForca) {
      // Captura janela de 380 ms para pegar o pico real e validar contra ruído de 1 amostra
      unsigned long tInicioCaptura = millis();
      long baseImpacto = taraHx;
      long pico1 = deltaHxAtual;
      long pico2 = min(deltaHxAtual, 4500L);

      while (millis() - tInicioCaptura < JANELA_IMPACTO_MS) {
        if (balanca.is_ready()) {
          long b = lerHx711Seguro();
          if (leituraHxValida(b)) {
            ultBrutoHx = b;
            long d = labs(b - baseImpacto);
            if (d <= LIMITE_GLITCH_BRUTO) {
              if (d > pico1) {
                pico2 = pico1;
                pico1 = d;
              } else if (d > pico2) {
                pico2 = d;
              }
            }
          }
        }
      }

      // Filtra bit-flips isolados (8192/16384/32768) e aplica curva de dificuldade alta (feira):
      long picoValidado = filtrarBitFlipIsolado(pico1, pico2);
      long excessoBruto = max(250L, picoValidado - ZONA_MORTA_IMPACTO);
      long picoForcaBruta = max(180L, (excessoBruto * 42L) / 100L);

      Serial.print(F("[IMPACTO] Pico1="));
      Serial.print(pico1);
      Serial.print(F(" | Pico2="));
      Serial.print(pico2);
      Serial.print(F(" | Validado="));
      Serial.print(picoValidado);
      Serial.print(F(" | ForcaFinal="));
      Serial.println(picoForcaBruta);

      // Calcular índice de força líquida da porrada (kgf), já descontada a tábua de 755g na tara da rodada
      float forcaKgf = picoForcaBruta / FATOR_CALIBRACAO_HX;

      // Calcular velocidade (m/s e km/h) registrada pelos sensores ópticos
      float velMs = 0.0f;
      noInterrupts();
      unsigned long t1 = tS1_us;
      unsigned long t1Fim = tS1_fim_us;
      unsigned long t2 = tS2_us;
      unsigned long t2Fim = tS2_fim_us;
      bool ok1 = s1Disparou;
      bool ok2 = s2Disparou;
      interrupts();

      if (ok1 && ok2 && t1 != t2) {
        unsigned long diffUs = (t2 > t1) ? (t2 - t1) : (t1 - t2);
        float dtSeg = diffUs / 1000000.0f;
        if (dtSeg > 0.002f && dtSeg < 2.0f) {
          velMs = (DIST_SENSORES_CM / 100.0f) / dtSeg;
        }
      }
      if (velMs <= 0.01f && ok2 && t2Fim > t2) {
        float dtPulso = (t2Fim - t2) / 1000000.0f;
        if (dtPulso > 0.001f && dtPulso < 1.0f) {
          velMs = (LARGURA_MARRETA_CM / 100.0f) / dtPulso;
        }
      }
      if (velMs <= 0.01f && ok1 && t1Fim > t1) {
        float dtPulso = (t1Fim - t1) / 1000000.0f;
        if (dtPulso > 0.001f && dtPulso < 1.0f) {
          velMs = (LARGURA_MARRETA_CM / 100.0f) / dtPulso;
        }
      }
      if (velMs <= 0.01f && forcaKgf > 0.1f) {
        velMs = constrain(1.5f + forcaKgf * 0.22f, 1.2f, 12.0f);
      }
      velMs = constrain(velMs, 0.0f, 18.0f);
      float velKmh = velMs * 3.6f;

      // Score de 0 a 1000 proporcional EXCLUSIVAMENTE à força bruta (11.000 bruto ~= 917 pts; 12.000 = 1000 pts)
      int score = (int)constrain(round((picoForcaBruta / FORCA_BRUTA_MAX_SCORE) * 1000.0f), 15, 1000);

      // Exibir no LCD 16x2
      char l1[17], l2[17];
      char vStr[7], fStr[7];
      dtostrf(velMs, 4, 1, vStr);
      dtostrf(forcaKgf, 4, 1, fStr);
      snprintf(l1, sizeof(l1), "V:%sm/s F:%skg", vStr, fStr);
      snprintf(l2, sizeof(l2), "PTS:%-4d F:%-5ld", score, picoForcaBruta);
      escreverLcd(l1, l2);

      // Enviar JSON oficial de resultado para o site_ranking
      Serial.print(F("{\"event\":\"result\",\"player\":\""));
      Serial.print(nomeJogador);
      Serial.print(F("\",\"speed_ms\":"));
      Serial.print(velMs, 2);
      Serial.print(F(",\"speed_kmh\":"));
      Serial.print(velKmh, 2);
      Serial.print(F(",\"force_raw\":"));
      Serial.print(picoForcaBruta);
      Serial.print(F(",\"force_kgf\":"));
      Serial.print(forcaKgf, 2);
      Serial.print(F(",\"score\":"));
      Serial.print(score);
      Serial.println(F(",\"board_discounted\":true}"));

      somResultado(score);
      estadoAtual = ESTADO_RESULTADO;
      inicioEstadoMs = millis();
    }
  }
  else if (estadoAtual == ESTADO_RESULTADO) {
    if (agoraMs - inicioEstadoMs >= TEMPO_RESULTADO_MS) {
      irParaIdle();
    }
  }
}
