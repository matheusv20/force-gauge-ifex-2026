# Medidor de Força (*High Striker*) — IFEX 2026/2
### Instituto Federal do Triângulo Mineiro (IFTM) — Projeto Interdisciplinar

[![Status](https://img.shields.io/badge/Status-Concluído%20com%20Sucesso-success.svg)](#)
[![Evento](https://img.shields.io/badge/Evento-IFEX%202026%2F2%20(IFTM)-blue.svg)](#)
[![Hardware](https://img.shields.io/badge/Hardware-Arduino%20Uno%20%7C%20HX711-orange.svg)](#)
[![Software](https://img.shields.io/badge/Stack-Python%20%7C%20SSE%20%7C%20Web%20Audio-yellow.svg)](#)

Sistema embarcado e aplicação web em tempo real inspirado nas clássicas máquinas de teste de força de parque de diversões (*High Striker*), desenvolvido para apresentação na **IFEX 2026/2** do **Instituto Federal de Educação, Ciência e Tecnologia do Triângulo Mineiro (IFTM)**.

O projeto combina uma estrutura mecânica em MDF de 15 mm, instrumentação com 4 células de carga em ponte completa de Wheatstone, cronometragem óptica de velocidade de descida da marreta por infravermelho, microcontrolador Arduino Uno e uma plataforma web interativa com Telão público estilo arcade e Painel de Controle do Operador.

---

## 👥 Integrantes do Grupo
* **Matheus Viana**
* **Matheus Alcântara**
* **Eduardo Goulart**
* **Miguel Medeiros**
* **João Victor Veronez**
* **Iago Baptista**

---

## 🏆 Resultados Oficiais na IFEX 2026/2 (IFTM)
Durante a mostra de projetos da **IFEX 2026/2**, o protótipo operou ininterruptamente com enorme engajamento do público acadêmico e da comunidade:

* **Mais de 130 participantes distintos** (~135 a 140 pessoas únicas) testaram o medidor.
* **228 testes registrados** e persistidos com telemetria serial em tempo real.
* **Ritmo acelerado de testes:** Média de **1 batida a cada ~28 segundos** durante 1h45min ininterruptos.
* **40,7% de taxa de retorno (*replay*):** 55 participantes voltaram para bater novamente (de 2 a 6 vezes) disputando as primeiras posições do ranking no Telão.
* **Pontuação média de 590 pontos** (escala calibrada de 0 a 1000) e velocidade média de **16,7 km/h**.

---

## 🛠️ Arquitetura do Sistema

```
                      +-----------------------------+
                      |   Estrutura Mecânica MDF    |
                      |   Alvo 755g + EVA + 4 Cel.  |
                      +--------------+--------------+
                                     |
    +--------------------------------+--------------------------------+
    |                                |                                |
[PIR HC-SR501]              [2x TCRT5000 Ópticos]             [4x Células 50kg]
Detecção de Jogador         Cronógrafo de Velocidade         Ponte de Wheatstone
    | (D7)                           | (D2 / D3 - INT0/INT1)          | (D4 / D5)
    +--------------------------------+--------------------------------+
                                     |
                                     v
                       +---------------------------+
                       |   Arduino Uno (ATmega328) |
                       |    medidor_de_forca.ino   |
                       +-------------+-------------+
                                     |
                 +-------------------+-------------------+
                 |                                       |
          [LCD 16x2 I2C]                           [Buzzer D8]
          Endereço 0x27                        Contagem 3, 2, 1!
                 |
                 +--- USB Serial (115200 baud, JSON) --->+
                                                         |
                                                         v
                                           +---------------------------+
                                           |  Servidor Web Python      |
                                           |  (server.py + pyserial)   |
                                           +-------------+-------------+
                                                         |
                                 +-----------------------+-----------------------+
                                 | (SSE: /api/events)                            | (HTTP: /operador)
                                 v                                               v
                     +-----------------------+                       +-----------------------+
                     |  Telão Público        |                       |  Painel do Operador   |
                     |  - Coluna de Força    |                       |  - Cadastro de nomes  |
                     |  - Confetes Top 3     |                       |  - Iniciar / Reset    |
                     |  - Ranking ao Vivo    |                       |  - Monitor Serial     |
                     +-----------------------+                       +-----------------------+
```

---

## 📌 Mapa Oficial de Pinos (Arduino Uno)

| Pino | Componente Conectado | Função e Configuração Elétrica |
|---|---|---|
| **`D2` (`INT0`)** | Sensor TCRT5000 #1 (Superior) | `INPUT_PULLUP` — Cronógrafo de descida da marreta por interrupção externa |
| **`D3` (`INT1`)** | Sensor TCRT5000 #2 (Inferior) | `INPUT_PULLUP` — Cronógrafo de descida da marreta por interrupção externa |
| **`D4`** | Conversor ADC 24-bits HX711 | `DT` (`DOUT`) — Leitura serial da ponte de extensômetros |
| **`D5`** | Conversor ADC 24-bits HX711 | `SCK` — Clock síncrono com atraso de acomodação de sinal |
| **`D7`** | Sensor PIR HC-SR501 | `INPUT` — Detecção de presença por infravermelho passivo |
| **`D8`** | Buzzer (espelho em `D6`/`D9`) | `OUTPUT` — Driver híbrido (onda quadrada AC + nível DC contínuo) |
| **`A4 (SDA)`** | Display LCD 16×2 I2C | Barramento I2C (`0x27`) com rotina de auto-recuperação |
| **`A5 (SCL)`** | Display LCD 16×2 I2C | Clock I2C (`0x27`) com destravamento de barramento (9 pulsos) |

---

## 💻 Como Executar o Projeto

### 1. Gravar o Firmware no Arduino Uno
Abra o arquivo [`medidor_de_forca/medidor_de_forca.ino`](medidor_de_forca/medidor_de_forca.ino) na Arduino IDE ou compile via terminal com `arduino-cli`:
```bash
arduino-cli compile --fqbn arduino:avr:uno medidor_de_forca
arduino-cli upload -p /dev/ttyACM0 --fqbn arduino:avr:uno medidor_de_forca
```

### 2. Iniciar a Aplicação Web
O servidor web do ranking utiliza Python 3 e `pyserial`:
```bash
cd site_ranking
./run.sh --auto-connect
```
* **Telão Público (Projetor / Tela Cheia):** [http://127.0.0.1:8000/](http://127.0.0.1:8000/) *(pressione `F` para tela cheia e clique na tela para liberar o áudio do navegador)*
* **Painel do Operador:** [http://127.0.0.1:8000/operador](http://127.0.0.1:8000/operador)

---

## 📁 Estrutura deste Repositório

```text
├── medidor_de_forca/
│   └── medidor_de_forca.ino          # Firmware oficial consolidado do Arduino Uno
├── site_ranking/
│   ├── server.py                     # Backend HTTP + SSE + Serial em Python
│   ├── run.sh                        # Script de inicialização automática
│   ├── requirements.txt              # Dependência (pyserial)
│   ├── data/
│   │   └── ranking.json              # Base de dados real com as 228 batidas da IFEX
│   └── static/                       # Frontend (Telão e Painel do Operador em HTML/CSS/JS)
├── docs/fotos/                       # Galeria de fotos do protótipo e da feira
├── RELATORIO_FINAL_PROJETO.pdf       # Relatório acadêmico oficial pronto para entrega
├── RELATORIO_FINAL_PROJETO.md        # Relatório técnico completo em Markdown
└── README.md                         # Documentação central do projeto
```

---

## 📄 Documentação Acadêmica Completa
Para detalhes minuciosos de modelagem física, calibração dinâmica da tábua de 755 g, equacionamento cinemático e estatísticas completas da feira, consulte o [Relatório Técnico Final em PDF](RELATORIO_FINAL_PROJETO.pdf).
