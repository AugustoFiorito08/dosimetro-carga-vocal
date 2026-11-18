# Dosímetro de Carga Vocal con Identificación del Hablante v0.3

**Documento de especificaciones del sistema**  
**Versión del sistema:** 0.4.0  
**Versión del documento:** 1.0  
**Fecha:** 2026-11-04  
**Estado:** Prototipo experimental sujeto a identificación paramétrica y validación experimental

## 1. Descripción general

El Dosímetro de Carga Vocal con Identificación del Hablante v0.3 es una aplicación experimental para computadora que registra y procesa la señal obtenida mediante un micrófono externo próximo a la boca. Su finalidad es estimar la carga acumulada por el uso de la voz de una persona evaluada.

No es un dosímetro de ruido ambiental. El nivel acústico se utiliza solamente como una de las variables necesarias para caracterizar la emisión vocal y controlar la calidad de la señal. El sistema no calcula exposición ocupacional a ruido ni sustituye a un sonómetro o dosímetro de ruido.

El prototipo identifica fonación probablemente atribuible al hablante previamente enrolado, rechaza ruido y voces no coincidentes, estima la frecuencia fundamental, calcula un estado dinámico de carga reciente y actualiza simultáneamente cinco modelos matemáticos candidatos.

## 2. Finalidad y aplicaciones previstas

El sistema está diseñado para:

- medir el tiempo de fonación atribuible al hablante evaluado;
- medir el tiempo de no fonación;
- calcular el porcentaje de fonación;
- caracterizar episodios vocales y pausas;
- estimar la frecuencia fundamental de la voz;
- representar la acumulación y recuperación de la carga vocal reciente;
- calcular y comparar cinco modelos de dosis vocal dinámica;
- estudiar la influencia de la continuidad, fragmentación y pausas sobre la carga calculada;
- generar datos para identificación paramétrica y validación experimental;
- apoyar investigaciones sobre sobrecarga vocal ocupacional, especialmente en profesiones de alta demanda vocal.

No está diseñado para:

- medir dosis de ruido ocupacional;
- diagnosticar disfonía, fatiga vocal o lesión de los pliegues vocales;
- establecer incapacidad laboral;
- determinar por sí solo un límite permisible;
- reemplazar una evaluación otorrinolaringológica, fonoaudiológica, acústica o epidemiológica;
- efectuar identificación biométrica forense.

## 3. Arquitectura funcional

La cadena de procesamiento es:

```text
Micrófono externo
        |
        v
Adquisición de audio digital
        |
        v
Control de calidad y estimación del ruido de fondo
        |
        v
Detección de actividad vocal y periodicidad
        |
        v
Estimación de F0 y características espectrales
        |
        v
Comparación con el perfil del hablante enrolado
        |
        +--> Voz atribuida al hablante
        +--> Voz no atribuida
        +--> Ruido rechazado
        +--> Silencio
        +--> Señal incierta
        |
        v
Actualización de H y de los cinco modelos de carga vocal
        |
        v
Visualización, registro y exportación CSV
```

## 4. Hardware

### 4.1 Equipo principal

- Computadora personal con navegador compatible.
- Micrófono externo de diadema o lavalier, preferentemente próximo a la boca.
- Interfaz USB o interfaz de audio compatible, cuando corresponda.
- Altavoces o auriculares no son necesarios para la medición.

### 4.2 Configuración recomendada del micrófono

- Posición fija y reproducible.
- Distancia boca-micrófono documentada.
- Cable asegurado para reducir artefactos de movimiento.
- Control automático de ganancia desactivado, cuando el controlador lo permita.
- Supresión de ruido y cancelación de eco desactivadas durante la adquisición científica, siempre que el navegador y el dispositivo lo permitan.
- Calibración previa y posterior si se pretende expresar presión acústica en pascales o nivel de presión sonora en decibeles.

### 4.3 Navegadores

Se recomienda utilizar versiones actuales de Google Chrome o Microsoft Edge. El navegador debe permitir `getUserMedia` y selección del dispositivo de entrada.

## 5. Adquisición de audio

El sistema permite seleccionar explícitamente el micrófono externo de la PC. La aplicación solicita autorización para acceder al dispositivo y procesa la señal localmente.

Variables primarias:

- muestras de audio digital;
- marca temporal;
- energía eficaz de la trama;
- relación señal-ruido estimada;
- periodicidad;
- frecuencia fundamental;
- características espectrales;
- score de semejanza con el hablante enrolado;
- decisión de atribución;
- motivo de rechazo.

La amplitud digital no debe interpretarse automáticamente como presión acústica en Pa. Esa conversión exige calibración de la cadena completa (§5.1).

Antes de cualquier análisis (medición de ambiente, enrolamiento y medición), cada trama pasa por un filtro pasa-altos Butterworth de 2.º orden con corte en 50 Hz. El filtro elimina el offset DC y el ruido de baja frecuencia que agregan muchos micrófonos y conversores, y que de otro modo inflarían la energía eficaz, el piso de ruido y la SNR, y desplazarían energía fuera de la banda vocal. El corte queda por debajo del límite inferior de F0 (70 Hz), con una pérdida aproximada de 1 dB a 70 Hz. El filtro procesa todas las tramas, también en reposo y en pausa, para que su estado sea continuo. La frecuencia de corte se registra en los parámetros exportados (`highPassHz`).

### 5.1 Calibración acústica

La presión eficaz se obtiene de la amplitud digital mediante:

```text
P_RMS = C_mic * A_digital

C_mic = P_ref / A_digital,ref
P_ref = 20 µPa * 10^(L_ref / 20)
```

Donde `L_ref` es el nivel conocido de un tono de referencia en dB SPL: un calibrador acústico (habitualmente 94 o 114 dB SPL a 1 kHz) o un tono estable medido con un sonómetro en la posición del micrófono. `A_digital,ref` es la media energética del RMS de las tramas del tono durante 5 s. Todas las tramas pasan antes por el filtro pasa-altos, igual que durante la medición.

La captura se rechaza si:

- dura menos de 3 s;
- alguna muestra satura (pico ≥ 0,999);
- no hay señal;
- la desviación estándar del nivel de las tramas supera 0,5 dB (tono inestable).

Secuencia:

- **Calibración previa:** fija `C_mic` para la próxima sesión. Sin ella, la sesión queda en unidades relativas.
- **Verificación posterior:** repite la captura al terminar la sesión y calcula la deriva respecto de la calibración que usó la sesión:

```text
delta_C = 100 * (C_post - C_pre) / C_pre        (%)
delta_C_dB = 20 * log10(C_post / C_pre)         (dB)
```

La sesión se marca fuera de tolerancia cuando `|delta_C_dB|` supera 0,5 dB. Los límites de 0,5 dB (estabilidad y deriva) son provisionales y deben preregistrarse tras la validación de banco.

La calibración corrige la ganancia de toda la cadena (micrófono, interfaz y navegador) solo para la posición, la ganancia y el dispositivo con que se realizó. Cualquier cambio de ganancia o de dispositivo exige recalibrar.

## 6. Enrolamiento e identificación del hablante

### 6.1 Enrolamiento

El hablante evaluado registra una muestra de voz de aproximadamente 10 a 20 segundos. La muestra debe contener habla clara, variación fonética suficiente y una relación señal-ruido adecuada.

### 6.2 Perfil acústico

La versión 0.3 utiliza:

- 12 coeficientes de envolvente espectral;
- banco de filtros Mel;
- centroide espectral global;
- hasta ocho prototipos fonéticos;
- similitud coseno;
- suavizado temporal de la decisión.

### 6.3 Regla de aceptación

La fonación se incorpora a la carga únicamente cuando se cumplen simultáneamente los criterios de voz, identidad y calidad:

```text
Phi_k = V_k * W_k * Q_k
```

Donde:

- `V_k = 1`: se detecta una emisión vocal periódica;
- `W_k = 1`: la emisión es compatible con el perfil enrolado;
- `Q_k = 1`: la calidad de la señal es suficiente;
- `Phi_k = 1`: fonación aceptada y atribuida al hablante.

Si cualquiera de los tres factores es cero, la trama no incrementa la dosis vocal.

### 6.4 Alcance

El procedimiento es un clasificador experimental de hablante objetivo frente a no objetivo. No constituye identificación biométrica forense. Debe validarse con sensibilidad, especificidad, falsa aceptación y falso rechazo.

## 7. Rechazo de ruido y señales no válidas

Una señal no se considera voz únicamente porque supere un umbral de amplitud. El sistema combina criterios para rechazar:

- señal inferior a la puerta adaptativa;
- relación señal-ruido insuficiente;
- ruido aperiódico o de banda ancha;
- impulsos con factor de cresta elevado;
- energía fuera de la banda vocal;
- voz no coincidente con el perfil enrolado;
- señal incierta.

Las categorías se contabilizan por separado:

1. Fonación atribuida.
2. Voz no atribuida.
3. Ruido rechazado.
4. Silencio.
5. Señal incierta.

El ruido se usa para decidir la calidad de la señal, no para calcular una dosis de ruido.

## 8. Variables de uso vocal

El sistema calcula:

- tiempo total de evaluación;
- tiempo de fonación atribuida;
- tiempo de no fonación;
- porcentaje de fonación;
- porcentaje de no fonación;
- duración de episodios vocales;
- duración de pausas;
- número de episodios aceptados;
- frecuencia fundamental por trama válida;
- nivel relativo o presión calibrada;
- estado dinámico de carga reciente;
- dosis acumulada por cada modelo.

El porcentaje de fonación se calcula como:

```text
Porcentaje_fonacion = 100 * T_fonacion / (T_fonacion + T_no_fonacion)
```

La definición de no fonación debe conservar la clasificación original para distinguir silencio, ruido, voz ajena y señal incierta.

## 9. Estado dinámico de carga vocal

El estado de carga reciente se actualiza mediante:

```text
H_k = H_(k-1) * exp(-beta * Delta_t) + Phi_k * Delta_t
```

Donde:

- `H_k`: estado dinámico de carga reciente;
- `beta`: constante de recuperación, en `s^-1`;
- `Delta_t`: intervalo temporal, en segundos;
- `Phi_k`: fonación aceptada, 0 o 1.

Cuando existe fonación atribuida, `H` aumenta. Durante la no fonación, `H` decae exponencialmente. La constante de tiempo y la semivida son:

```text
tau = 1 / beta

t_1/2 = ln(2) / beta
```

`beta` es un parámetro experimental y no debe interpretarse como constante fisiológica validada hasta completar la identificación paramétrica.

Bajo fonación continua, `H` tiende a `Delta_t / (1 - exp(-beta * Delta_t))`, que es aproximadamente `tau = 1 / beta`. Por lo tanto, el dominio alcanzable de `H` está acotado por `beta` (300 s con `beta = 1/300 s^-1`), y los parámetros de las funciones de memoria deben fijarse en relación con ese dominio.

## 10. Carga acústica normalizada

La función inicial es:

```text
I_k = (P_k / P_0)^2
```

Donde:

- `P_k`: presión acústica eficaz de la emisión vocal, o magnitud relativa si no existe calibración;
- `P_0`: referencia del modelo;
- `I_k`: carga acústica normalizada.

Con calibración acústica (§5.1), `P_k` está en Pa y `P_0 = 1 Pa` (94 dB SPL) por defecto, configurable. `P_0` es una convención de normalización del modelo, no un valor fisiológico, y se registra en los parámetros exportados (`referencePressure`).

Si no existe calibración, los resultados deben rotularse como relativos. La presión captada por el micrófono no equivale directamente a presión subglótica ni a presión de colisión de los pliegues vocales.

## 11. Modelos matemáticos implementados

Todos los modelos utilizan la misma señal, `F0_k`, `I_k`, `Phi_k`, `H_k` y `Delta_t`.

### 11.1 Modelo sin memoria

```text
D_0,k = D_0,k-1 + F0_k * I_k * Phi_k * Delta_t
```

Función:

```text
f_0(H) = 1
```

Es el modelo nulo para evaluar si el término de memoria mejora el desempeño.

### 11.2 Modelo lineal

```text
D_L,k = D_L,k-1 + F0_k * I_k * Phi_k * (1 + alpha_L * H_k) * Delta_t
```

Función:

```text
f_L(H) = 1 + alpha_L * H
```

### 11.3 Modelo potencial

```text
D_P,k = D_P,k-1 + F0_k * I_k * Phi_k * [1 + a * (H_k / H_ref)^p] * Delta_t
```

Función:

```text
f_P(H) = 1 + a * (H / H_ref)^p
```

### 11.4 Modelo exponencial principal

```text
D_E,k = D_E,k-1 + F0_k * I_k * Phi_k * exp(alpha_E * H_k) * Delta_t
```

Función:

```text
f_E(H) = exp(alpha_E * H)
```

Este es el modelo principal del desarrollo original. Se conserva como modelo candidato, sin asumir que la fisiología vocal sea necesariamente exponencial.

### 11.5 Modelo saturante

```text
D_S,k = D_S,k-1 + F0_k * I_k * Phi_k * [1 + A * H_k / (K_H + H_k)] * Delta_t
```

Función:

```text
f_S(H) = 1 + A * H / (K_H + H)
```

Los parámetros `alpha_L`, `a`, `p`, `H_ref`, `alpha_E`, `A`, `K_H` y `beta` deben identificarse y validarse experimentalmente.

### 11.6 Anclaje común de los parámetros

Para que los modelos sean comparables, todas las funciones de memoria se anclan en dos puntos:

```text
f(0) = 1
f(H*) = f*
```

Con `H*` en segundos y `f* >= 1`, los parámetros de forma se derivan así:

```text
alpha_L = (f* - 1) / H*
a       = f* - 1,   H_ref = H*,   p libre (por defecto 2)
alpha_E = ln(f*) / H*
A       = (f* - 1) * (K_H + H*) / H*,   K_H libre (por defecto H*)
```

Valores provisionales por defecto: `beta = 1/300 s^-1`, `H* = tau = 1 / beta = 300 s`, `f* = 2`. Como `H` no supera aproximadamente `tau` bajo fonación continua, `f*` es la máxima amplificación que puede alcanzar cualquier modelo candidato en el dominio alcanzable. Los modelos difieren solo en la curvatura entre `0` y `H*` (convexa, lineal o cóncava), que es justamente la hipótesis a contrastar.

Reglas de configuración:

- Si se modifica `beta` sin indicar `H*`, el anclaje se recalcula con `H* = 1 / beta`.
- Si `beta = 0` (sin recuperación) y no se indica `H*`, se usa `H* = 300 s`.
- Los parámetros de forma indicados explícitamente (`alpha_L`, `a`, `H_ref`, `alpha_E`, `A`) prevalecen sobre los derivados del anclaje.

El anclaje es una convención de comparación, no un resultado fisiológico. `H*` y `f*` se registran en los parámetros exportados.

### 11.7 Dosis convencionales

Como referencia sin término de memoria, comparable con la literatura (Titze, Švec y Popolo, 2003), se calculan:

```text
D_t,k = D_t,k-1 + Phi_k * Delta_t            (dosis de tiempo, s)
D_c,k = D_c,k-1 + Phi_k * F0_k * Delta_t     (dosis de ciclos, ciclos vibratorios)
```

No dependen de la presión ni de `H`. Permiten construir condiciones experimentales con dosis convencional equivalente y distinta distribución temporal de pausas.

### 11.8 Dosis de distancia

Siguiendo a Titze, Švec y Popolo (2003, *JSLHR* 46:919-932), la dosis de distancia vibratoria estima la distancia total recorrida por los pliegues vocales en su trayectoria oscilatoria. Es otra forma de expresar la dosis, sensible a la vez a `F0` y a la intensidad:

```text
D_d = 4 * ∫ k_v * A * F0 dt                          (m)          ec. 22
A    = 0.05 * L0 * [(P_L - P_th) / P_th]^(1/2)       (m)          ec. 14
P_th = 0.14 + 0.06 * (F0 / F0N)^2                    (kPa)        ec. 15
P_L  = P_th + 10^((SPL_0.5m - 78.5) / 27.3)          (kPa)        ec. 16
```

Con `k_v = Phi_k` y la forma discreta `D_d,k = D_d,k-1 + 4 * Phi_k * A_k * F0_k * Delta_t`. Los parámetros dependen del perfil del modelo:

| Perfil | `L0` | `F0N` |
|---|---|---|
| Masculino | 16 mm | 120 Hz |
| Femenino | 10 mm | 190 Hz |

`A`, `P_th` y `P_L` son reglas empíricas del trabajo citado (amplitud medida en laringes caninas extirpadas; umbral y presión pulmonar de Titze y Sundberg, 1992). No son mediciones del participante.

**Referencia del SPL.** La ecuación 16 usa el SPL a 0,5 m de la boca. El micrófono de diadema mide mucho más cerca, por lo que se resta una diferencia `SPL_mic - SPL_0.5m`:

- **medida** (preferida, como en el trabajo citado): se graba una vocal sostenida a la vez con el micrófono de diadema y con un sonómetro a 50 cm, y se ingresa la diferencia en dB;
- **estimada por distancia** (aproximación): `20 * log10(0,5 / r)`, con `r` la distancia boca-micrófono en metros. Supone propagación esférica desde una fuente puntual, lo que no se cumple bien cerca de la boca, así que el resultado debe rotularse como aproximado.

**Aclaración: entradas en esta implementación.** `D_d` se calcula con las señales que ya produce el dosímetro, no con las del trabajo original:

| | Titze, Švec y Popolo (2003) | Este dosímetro |
|---|---|---|
| `F0` | Electroglotógrafo (EGG), un valor por ciclo vibratorio | Estimador YIN sobre la señal del micrófono, un valor por trama (§5) |
| `k_v` | Sonoridad detectada en el EGG, por ciclo | `Phi_k = V_k * W_k * Q_k`: voz, hablante verificado y calidad (§6.3) |
| SPL | RMS por ciclo del micrófono de diadema, referido a 50 cm con un sonómetro | RMS por trama del micrófono calibrado (§5.1), referido a 50 cm con la diferencia medida o estimada |

Por eso `D_d` es comparable en orden de magnitud con los valores publicados, pero no idéntica: los errores de octava de `F0`, la resolución por trama y la atribución del hablante se trasladan a la dosis.

`D_d` solo se calcula en sesiones con calibración acústica (§5.1) y con un perfil elegido. Pedirla en una sesión sin calibrar es un error explícito; nunca se ignora en silencio. El trabajo citado menciona, como punto de partida tomado de la vibración transmitida a la mano, un límite de unos 520 m; no es un límite validado para los pliegues vocales y la aplicación no lo usa como zona ni umbral.

## 12. Interfaz

La pantalla funcional incluye:

- selector de micrófono;
- medición de ambiente;
- calibración de nivel;
- enrolamiento del hablante;
- umbral de similitud;
- iniciar, pausar, continuar y finalizar;
- estado de atribución;
- score de hablante;
- relación señal-ruido;
- frecuencia fundamental;
- nivel relativo o calibrado;
- tiempo de fonación;
- tiempo de no fonación;
- porcentaje de fonación;
- voz no atribuida;
- ruido descartado;
- silencio;
- estado `H`;
- valores de los cinco modelos;
- dosis de distancia, con perfil y referencia del SPL a 50 cm;
- gráfico temporal;
- zonas provisionales;
- exportación CSV.

Las zonas de carga son provisionales y no deben interpretarse como límites clínicos o legales.

## 13. Exportación de datos

La aplicación exporta un archivo CSV por trama. Debe incluir, como mínimo:

- timestamp;
- duración de trama;
- `F0`;
- nivel;
- SNR;
- periodicidad;
- score del hablante;
- decisión de voz;
- decisión de identidad;
- decisión de calidad;
- `Phi_k`;
- categoría final;
- motivo de rechazo;
- `H_k`;
- dosis sin memoria;
- dosis lineal;
- dosis potencial;
- dosis exponencial;
- dosis saturante;
- versión del algoritmo;
- parámetros usados;
- dosis de tiempo (`d_t`);
- dosis de ciclos (`d_c`);
- presión eficaz en Pa (`pressure_pa`) y nivel en dB SPL (`spl_db`), vacíos si la sesión no está calibrada;
- dosis de distancia en metros (`d_d`), vacía si no se calcula (§11.8).

Con dosis de distancia, los parámetros incluyen `ddProfile`, `ddOffsetDb`, `ddOffsetSource` (`measured` o `inverse_distance`) y, si corresponde, `ddMouthDistanceM`. Con calibración, los parámetros incluyen `calRefDbSpl` y `calCoefficient`. Tras la verificación posterior se agregan `calPostCoefficient`, `calDriftPct`, `calDriftDb` y `calWithinTolerance`; al exportar, estos valores se escriben en todas las filas de la sesión.

Las columnas nuevas se agregan al final para no alterar la posición de las existentes.

La conservación de scores continuos permite recalcular decisiones con nuevos umbrales sin repetir la medición.

## 14. Privacidad

- El procesamiento se realiza localmente.
- El audio no se conserva por defecto.
- La plantilla del hablante puede mantenerse en memoria o guardarse localmente.
- La plantilla debe considerarse un dato sensible.
- Para investigación con personas se requiere consentimiento informado y revisión ética.
- La base analítica debe utilizar identificadores codificados.

## 15. Instalación y ejecución

1. Descomprimir `dosimetro_carga_vocal_hablante_v0.3.zip`.
2. Abrir una terminal dentro de la carpeta del proyecto.
3. Ejecutar:

```bash
npm start
```

o, sin npm, `python3 scripts/dev-server.py 8080`. El servidor envía `Cache-Control: no-store` para que el navegador no siga ejecutando módulos JavaScript viejos después de una actualización (con `python3 -m http.server` puede ocurrir). Las páginas HTML incluyen además `Clear-Site-Data: "cache"`, así que al abrir la aplicación se descarta lo que haya quedado en caché de un servidor anterior, sin que el usuario tenga que forzar la recarga.

4. Abrir en Chrome o Edge:

```text
http://localhost:8080/public/index.html
```

El acceso a micrófono requiere un contexto seguro. `localhost` es admitido por los navegadores modernos para pruebas locales.

## 16. Secuencia de uso

1. Conectar el micrófono externo.
2. Abrir la aplicación.
3. Autorizar el acceso al micrófono.
4. Seleccionar el dispositivo correcto.
5. Medir al menos cinco segundos de ambiente silencioso.
6. Calibrar la cadena con el tono de referencia si se utilizarán Pa o dB SPL (§5.1).
7. Mantener fija la posición del micrófono.
8. Enrolar la voz durante 10 a 20 segundos.
9. Revisar el score y el umbral de similitud.
10. Iniciar la medición.
11. Controlar SNR, atribución y calidad.
12. Finalizar la sesión.
13. Si la sesión fue calibrada, verificar la calibración con el mismo tono de referencia, sin cambiar la ganancia ni la posición.
14. Exportar el CSV.

## 17. Verificación de la versión 0.3

La versión entregada superó:

- 13 de 13 pruebas automatizadas;
- verificación de las cinco ecuaciones;
- pruebas de fonación y no fonación;
- verificación del porcentaje de fonación;
- rechazo sintético de ruido de banda ancha;
- rechazo de silencio e impulsos;
- construcción y comparación de perfiles;
- validación sintáctica de módulos;
- inicialización de interfaz;
- respuesta HTTP local;
- comprobación de integridad del archivo ZIP.

SHA-256 del paquete entregado:

```text
c2f79233854439dcd14699bdaff14b05fa819f302df363f6a50fda0819370aa1
```

## 18. Protocolo mínimo de prueba funcional

Realizar cinco condiciones con el mismo micrófono y posición:

1. Silencio.
2. Ruido ambiental sin voz.
3. Voz del hablante enrolado.
4. Voz de otra persona.
5. Voz enrolada con ruido superpuesto.

Resultados esperados:

- silencio: no debe incrementar las dosis;
- ruido: debe rechazarse sin incrementar las dosis;
- voz enrolada: debe incrementar fonación, `H` y dosis;
- voz ajena: debe clasificarse como no atribuida;
- voz con ruido: debe aceptarse solo si la calidad y la atribución superan los criterios.

## 19. Limitaciones

- La identificación no elimina todos los falsos positivos.
- Puede degradarse con voces similares, habla simultánea, música tonal, reverberación elevada, cambios de distancia, disfonía severa o micrófono desplazado.
- El nivel no es metrológico sin calibración.
- Los parámetros de los modelos no están clínicamente identificados.
- Las dosis no equivalen automáticamente a daño, riesgo o probabilidad de enfermedad.
- No existe todavía un límite permisible validado.
- Las zonas visuales son experimentales.
- La validación sintética no sustituye ensayos con personas ni validación externa.

## 20. Validación requerida

Antes de utilizar el sistema para decisiones médico-laborales se requiere:

- validación de `F0` contra referencia;
- sensibilidad y especificidad de fonación;
- falsa aceptación y falso rechazo del hablante;
- desempeño con distintos SNR;
- pruebas con habla simultánea;
- repetibilidad y deriva instrumental;
- identificación de parámetros;
- comparación de modelos por MAE, RMSE, AIC, BIC y validación agrupada por participante;
- validación externa en docentes y otros usuarios no incluidos en el ajuste;
- evaluación epidemiológica de la relación entre dosis y desenlaces vocales.

## 21. Criterio metodológico

El sistema debe describirse como un modelo dinámico candidato sujeto a identificación y validación experimental. Los cinco modelos se mantienen en paralelo para seleccionar el más simple que presente una mejora estable, reproducible y relevante fuera de muestra.

La salida correcta es un índice experimental de carga vocal calculada. No debe denominarse daño tisular, diagnóstico, incapacidad ni límite permisible hasta contar con evidencia específica.

## 22. Control de versiones

| Versión | Fecha | Cambio |
|---|---|---|
| 0.3 | 2026-11-04 | Identificación experimental del hablante, rechazo de ruido y cálculo multimodelo |
| Documento 1.0 | 2026-11-04 | Especificación integral del sistema v0.3 |
| 0.3.1 | 2026-11-13 | Anclaje común `f(H*) = f*` ligado a `beta` y dosis convencionales de tiempo y de ciclos |
| 0.3.2 | 2026-11-13 | Filtro pasa-altos de 50 Hz en la entrada; corte registrado en los parámetros exportados |
| 0.4.0 | 2026-11-18 | Calibración acústica con tono de referencia, deriva pre/post, presión en Pa y nivel en dB SPL en el CSV, `P_0 = 1 Pa` con calibración, y dosis de distancia `D_d` de Titze, Švec y Popolo (2003) |
