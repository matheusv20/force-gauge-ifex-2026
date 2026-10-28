# RELATÓRIO TÉCNICO FINAL — IFEX 2026/2
## Instituto Federal do Triângulo Mineiro (IFTM) — Projeto Interdisciplinar
### Sistema Embarcado e Aplicação Web em Tempo Real: Medidor de Força (*High Striker*)

**Evento:** Mostra de Projetos IFEX 2026/2 — Instituto Federal do Triângulo Mineiro (IFTM)  
**Integrantes do Grupo:**
- **Matheus Alcântara Rosa**
- **Eduardo Goulart**
- **Miguel Medeiros**
- **João Victor Veronez**
- **Matheus Viana**
- **Iago Baptista**

**Data:** 28 de outubro de 2026  
**Plataforma de Hardware:** Microcontrolador ATmega328P (Arduino Uno)  
**Arquitetura de Software:** C/C++ Embarcado + Backend Python (HTTP / Server-Sent Events / PySerial) + Frontend Web Interativo (HTML5 / CSS3 / JavaScript / Web Audio API)

---

## 1. Resumo Executivo e Objetivo

Este relatório documenta o projeto, a construção mecânica, a integração eletrônica, a calibração física, a engenharia de software e a validação experimental de campo na Feira de Ciências do **Medidor de Força (*High Striker*)**, um protótipo funcional inspirado nas clássicas máquinas de teste de força de parques de diversões.

O objetivo central do projeto consiste em integrar conceitos de **instrumentação eletrônica, sistemas embarcados, mecânica estrutural, física aplicada (cinemática e dinâmica de impacto) e sistemas web em tempo real**. O equipamento detecta automaticamente a aproximação de um participante por infravermelho passivo, coordena o início da rodada com contagem regressiva audiovisual de 3 segundos, mede simultaneamente a **velocidade de descida da marreta** e a **força bruta de impacto**, exibe os dados localmente em um painel **LCD 16×2** e transmite a telemetria via **USB Serial (115200 baud)** para uma **Aplicação Web de Ranking ao Vivo (Telão Público e Painel do Operador)**.

---

## 2. Cumprimento dos Requisitos Acadêmicos

O projeto atendeu e superou todos os critérios técnicos exigidos pela disciplina:

| Critério Avaliativo | Requisito Mínimo | Implementação Realizada no Projeto | Status |
|---|---|---|---|
| **Sensores** | Mínimo de 3 sensores | **4 subsistemas sensores (7 elementos físicos):**<br/>1. Sensor de Presença `PIR HC-SR501` (`D7`)<br/>2. Sensor Óptico Infravermelho Superior `TCRT5000 #1` (`D2 / INT0`)<br/>3. Sensor Óptico Infravermelho Inferior `TCRT5000 #2` (`D3 / INT1`)<br/>4. Arranjo de 4× Células de Carga de `50 kg` em Ponte Completa de Wheatstone + Conversor ADC 24-bits `HX711` (`D4 / D5`) | ✅ **Superado** |
| **Atuadores e Interfaces** | Mínimo de 2 atuadores | **3 interfaces de saída:**<br/>1. Display Alfanumérico `LCD 16×2 I2C` (`0x27` em `SDA / SCL`)<br/>2. Transdutor Sonoro `Buzzer` (`D8` com espelhamento em `D6 / D9`)<br/>3. Sistema Multimídia de **Telão ao Vivo** (animação gráfica em Canvas, síntese sonora via *Web Audio API* e ranking em tempo real) | ✅ **Superado** |
| **Interação com o Usuário** | Fluxo interativo prático | Detecção automática de aproximação -> Cadastro pelo operador -> Contagem regressiva de 3 segundos (`3... 2... 1... VALENDO!`) -> Golpe físico -> Feedback imediato no LCD, Buzzer e Telão com classificação automática no Ranking | ✅ **Completo** |

---

## 3. Projeto Mecânico e Estrutural

A estrutura física foi construída em chapas de **MDF de 15 mm de espessura**, dimensionada para absorver impactos verticais com estabilidade, rigidez e segurança:

1. **Dimensões das Peças Estruturais:**
   - **Base / Plataforma de Impacto:** Composta por 2 placas horizontais de `60 × 35 cm`, 2 fechamentos laterais de `60 × 12 cm` e 1 fechamento frontal de `35 × 12 cm`, formando uma caixa rígida que transfere a carga dinamicamente para o solo.
   - **Torre Vertical:** Placa de `108 × 35 cm` fixada na parte traseira da base, responsável por abrigar o display LCD, o sensor PIR e a coluna dos sensores ópticos de velocidade.
   - **Mãos-Francesas (Reforços Triangulares):** 2 suportes triangulares laterais (~`25 cm`) parafusados na junção torre–base para anular momentos fletores e vibrações parasitas, deixando um vão central livre de ~`32 cm`.
2. **Plataforma Móvel do Alvo (`25 × 25 cm`, massa de `755 g`):**
   - Posicionada com folga lateral de ~`3,5 cm` de cada lado em relação aos reforços triangulares para eliminar perdas por atrito mecânico na madeira.
   - Apoiada diretamente sobre os ressaltos centrais das **4 células de carga** distribuídas nos cantos, revestida no topo por camada amortecedora de espuma/EVA de alta densidade para proteger os extensômetros contra choques secos e prolongar o pulso mecânico de deformação.
3. **Calços de Livre Flexão das Células de Carga:**
   - Como as células de meia-ponte operam pela deformação elástica da lingueta central (onde fica fixado o *strain gauge*), as molduras externas das 4 células foram apoiadas sobre calços espaçadores de `2–3 mm`, mantendo o núcleo central suspenso e livre para defletir sob compressão.

---

## 4. Arquitetura Eletrônica e Mapeamento de Hardware

### 4.1. Mapa Oficial de Pinos no Arduino Uno (`ATmega328P`)

| Pino Arduino | Componente Conectado | Pino do Módulo | Configuração Lógica / Elétrica |
|---|---|---|---|
| **`D2` (`INT0`)** | Sensor Infravermelho `TCRT5000 #1` (Superior) | `DO` (Saída Digital) | `INPUT_PULLUP` — Interrupção externa (`CHANGE`), ativo em `LOW` |
| **`D3` (`INT1`)** | Sensor Infravermelho `TCRT5000 #2` (Inferior) | `DO` (Saída Digital) | `INPUT_PULLUP` — Interrupção externa (`CHANGE`), ativo em `LOW` |
| **`D4`** | Conversor ADC 24-bits `HX711` | `DT` (`DOUT`) | Entrada serial de dados (leitura atômica de 24 bits) |
| **`D5`** | Conversor ADC 24-bits `HX711` | `SCK` (`PD_SCK`) | Saída de pulsos de clock síncrono com delay de acomodação |
| **`D7`** | Sensor Piroelétrico `PIR HC-SR501` | `OUT` | `INPUT` — Nível lógico `HIGH` (`3,3 V`) ao detectar movimento |
| **`D8`** *(e `D6`/`D9`)* | Transdutor Sonoro `Buzzer` | `(+)` / `S` | `OUTPUT` — Acionamento híbrido (onda quadrada AC + pulso DC `5 V`) |
| **`SDA` (`A4`)** | Display `LCD 16×2 I2C` (`PCF8574`, `0x27`) | `SDA` | Barramento serial de dados I2C |
| **`SCL` (`A5`)** | Display `LCD 16×2 I2C` (`PCF8574`, `0x27`) | `SCL` | Barramento de clock I2C |
| **`5V` / `GND`** | Barramento de Alimentação Comum | `VCC` / `GND` | Alimentação regulada `5 V DC` via barramento USB |

### 4.2. Ligação das 4 Células de Carga (50 kg) em Ponte Completa de Wheatstone

As 4 células de carga de meia-ponte (capacidade nominal combinada de `4 × 50 kg = 200 kg`) foram interligadas em uma **Ponte Completa de Wheatstone**, conectada aos terminais diferenciais do módulo **`HX711`**:

- **Malha Externa da Ponte (Extremidades dos Extensômetros):**
  - `Branco (Célula 1)` <-> `Branco (Célula 2)`
  - `Preto (Célula 2)` <-> `Preto (Célula 3)`
  - `Branco (Célula 3)` <-> `Branco (Célula 4)`
  - `Preto (Célula 4)` <-> `Preto (Célula 1)`
- **Terminais Centrais de Excitação e Sinal (Fios Vermelhos no HX711):**
  - `Vermelho (Célula 1)` -> **`E+`** (Excitação Positiva)
  - `Vermelho (Célula 3 — diagonal)` -> **`E-`** (Excitação Negativa / GND Analógico)
  - `Vermelho (Célula 2)` -> **`A+`** (Sinal Diferencial Positivo)
  - `Vermelho (Célula 4 — diagonal)` -> **`A-`** (Sinal Diferencial Negativo)

---

## 5. Modelagem Física, Equacionamento e Calibração

### 5.1. Medição de Velocidade por Cronógrafo Óptico Duplo (`INT0` e `INT1`)
Os sensores `TCRT5000` superior (`S1`, pino `D2`) e inferior (`S2`, pino `D3`) estão separados verticalmente por `d = 15 cm = 0,15 m`. Rotinas de interrupção de hardware (`attachInterrupt`) com resolução de microssegundos calculam a velocidade instantânea de descida:

$$\text{Velocidade (m/s)} = \frac{d}{\Delta t} = \frac{0{,}15}{|t_{S2} - t_{S1}| \times 10^{-6}}$$

$$\text{Velocidade (km/h)} = \text{Velocidade (m/s)} \times 3{,}6$$

Caso a trajetória em arco da marreta atinja apenas um dos feixes reflexivos, o firmware aciona um algoritmo de contingência baseado no tempo de obstrução do feixe (`\Delta t_{pulso}`) pela largura da cabeça da marreta (`L = 4{,}5\text{ cm} = 0{,}045\text{ m}`).

### 5.2. Desconto Automático da Tábua (755 g) e Tara Dinâmica em Tempo Real
A placa de impacto (`25 × 25 cm`) tem massa de **`755 g` (`0,755 kg`)**. 
Durante os testes de campo, identificou-se que a relaxação mecânica da madeira e o fato de participantes descansarem a marreta sobre o alvo antes de bater poderiam falsear a linha de base. Implementou-se um sistema de **tara dinâmica contínua**:
- O repouso é rastreado continuamente durante o repouso (`IDLE`), detecção do jogador (`PLAYER_DETECTED`) e durante toda a contagem regressiva (`COUNTDOWN`).
- No exato milissegundo em que o estado `"VALENDO! BATA!"` se inicia (`entrarEmReadyValendo()`), uma nova leitura atômica fixa a referência zero com a marreta já erguida no ar.

### 5.3. Calibração da Dificuldade e Supressão de Ruído de Vibração
Para garantir que pancadas fracas pontuassem na faixa inicial e apenas golpes extremamente fortes alcançassem o topo, definiu-se a seguinte cadeia de processamento:
1. **Filtro Anti-Bit-Flip (`filtrarBitFlipIsolado()`):** Descarta picos espúrios de potências de 2 ($8192, 16384, 32768$) causados por mau contato momentâneo na vibração mecânica extrema, comparando a maior amostra (`Pico1`) com a segunda maior (`Pico2`) na janela de captura de `380 ms`.
2. **Zona Morta de Repouso (`ZONA_MORTA_IMPACTO = 3000`):** Subtrai o piso de ruído mecânico/térmico.
3. **Escalonamento Progressivo de Dificuldade:**

$$\text{Excesso Bruto} = \max(250, \text{Pico Validado} - 3000)$$

$$\text{Força Bruta Final} = \max(180, \frac{\text{Excesso Bruto} \times 42}{100})$$

$$\text{Score} = \text{constrain}\left(\text{round}\left(\frac{\text{Força Bruta Final}}{12000} \times 1000\right), 10, 1000\right)$$

- **Critério Oficial do Ranking:** Os participantes são ordenados **exclusivamente pela Força Bruta Líquida da pancada (`force_raw` / `force_kgf`)**, mantendo visíveis a Pontuação (0 a 1000), Velocidade (m/s e km/h) e Data/Hora.

---

## 6. Engenharia de Firmware Embarcado (`medidor_de_forca.ino`)

O código oficial opera como uma **Máquina de Estados Finitos (FSM)** não-bloqueante com 5 estados (`ESTADO_IDLE`, `ESTADO_PLAYER_DETECTED`, `ESTADO_COUNTDOWN`, `ESTADO_READY` e `ESTADO_RESULTADO`).

### Soluções Técnicas de Confiabilidade Implementadas:
1. **Leitura Atômica e Temporizada do `HX711` (`lerHx711Seguro()`):**
   - A leitura serial de 24 bits é protegida com `noInterrupts()` / `interrupts()`, dupla checagem de estabilidade em `DT = LOW` e temporização de acomodação de sinal de clock (`delayMicroseconds(1)` em nível alto e baixo), eliminando leituras corrompidas durante o choque mecânico.
2. **Driver I2C por Software com Ressincronização 4-Bit do LCD:**
   - Recuperação automática de barramento travado (9 pulsos de clock) e envio de comandos de ressincronização de *nibbles* (`0x30 / 0x20`) antes de cada escrita no display, prevenindo caracteres indecifráveis após vibrações.
3. **Driver Híbrido de Buzzer e Contagem Regressiva de 3s:**
   - Conduz os participantes com bipes audíveis em `3... 2... 1...` e um tom contínuo de liberação em `"VALENDO!"`, acionando tanto buzzers passivos (AC) quanto ativos (DC).
4. **Auto-Retorno Inteligente do Sensor `PIR` (`D7`):**
   - Janela máxima de retenção de 8 segundos na detecção de presença, retornando automaticamente a `"Em repouso..."` se o participante não iniciar a rodada, evitando travamentos.

---

## 7. Aplicação Web em Tempo Real (`site_ranking/`)

Desenvolvida com **Python puro (`server.py`)** + **`pyserial`** e arquitetura reativa via **Server-Sent Events (`SSE` em `/api/events`)**:

1. **Telão Público (`http://127.0.0.1:8000/`):**
   - Visual estilo *arcade*, coluna de força animada, contagem regressiva gigante sincronizada, efeitos sonoros sintetizados via *Web Audio API*, chuva de confetes em Canvas para o Top 3 / Recordes, Pódio e Tabela completa do Ranking.
2. **Painel do Operador (`http://127.0.0.1:8000/operador`):**
   - Conexão e desconexão serial sob demanda, entrada de nomes com sanitização para o LCD 16×2 (preservando o nome completo com acentos no Telão), zeramento de tara, simulação de testes, exportação de relatórios em **CSV/JSON** e Monitor Serial integrado.
3. **Persistência Atômica de Dados:**
   - Escrita atômica em disco (`ranking.json` via arquivo temporário e `os.replace` com `fsync`), prevenindo perda ou corrupção de dados em caso de queda de energia, além de rotina de backup automático a cada limpeza do ranking.

---

## 8. Resultados Experimentais e Validação em Campo (Feira de Ciências)

O protótipo foi colocado à prova em condições reais durante a **Feira de Ciências**, operando ininterruptamente com altíssimo fluxo de participantes. Os dados registrados comprovam o sucesso e a estabilidade do equipamento:

### Métricas Consolidadas da Feira de Ciências:
* **Total de Batidas Registradas no Banco de Dados:** **228 testes**
* **Testes Técnicos de Bancada da Equipe:** **2 testes** (*"teste"* e *"test"*)
* **Total Efetivo de Batidas do Público:** **226 testes reais**
* **Público Único Participante:** **Entre 135 e 140 participantes distintos** (sendo 80 pessoas que realizaram 1 tentativa e 55 pessoas que retornaram para realizar de 2 a 6 tentativas com o intuito de superar seus recordes).
* **Período de Operação Intensiva:** das **14:03 às 15:48** (~1h45min ininterruptos, com ritmo operacional de **1 teste a cada ~28 segundos**).
* **Distribuição Estatística da Pontuação:**
  - **Pontuação Média Geral:** **590 pontos** (mediana de **610 pontos**, variando de **37 a 1000 pontos**).
  - **Velocidade Média da Marreta:** **16,7 km/h**.
  - A curva progressiva de dificuldade garantiu que batidas casuais ficassem na faixa de 100 a 300 pontos, batidas regulares entre 400 e 700 pontos, e apenas os competidores com marretada potente de duas mãos atingissem o patamar de 900 a 1000 pontos.

---

## 9. Conclusão

A integração entre a estrutura física em MDF de 15 mm, o arranjo de células de carga em ponte completa de Wheatstone com o conversor HX711, os sensores ópticos infravermelhos por interrupção de hardware, o microcontrolador ATmega328P e a aplicação web distribuída cumpriu com excelência todos os requisitos acadêmicos, técnicos e de experiência do usuário. O projeto demonstrou robustez eletrônica, precisão na discriminação de forças e enorme apelo interativo diante de mais de 130 pessoas na feira, consolidando na prática os conhecimentos de engenharia interdisciplinar.
