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

Desde la versión 0.5 el enrolamiento es guiado: la primera mitad con la voz habitual y la segunda en voz alta, como al dar clase. El perfil debe cubrir la voz elevada porque es la que más carga aporta; con un perfil enrolado solo en voz normal, la voz elevada de la propia docente se rechaza en buena parte.

### 6.2 Perfil acústico

La versión 0.5 utiliza:

- 12 coeficientes cepstrales de envolvente espectral sobre banco de filtros Mel, calculados sobre el espectro de potencia suavizado con una media móvil de 400 Hz, más ancha que la separación entre armónicos, para que la envolvente dependa del tracto vocal y mucho menos de F0;
- centroide espectral global;
- estandarización de cada característica con la media y la dispersión del enrolamiento;
- hasta ocho prototipos fonéticos (k-means), cada uno con su varianza por dimensión;
- distancia de Mahalanobis normalizada al prototipo más cercano, `delta = min_c (1/d) * sum_j (z_j - c_j)^2 / v_cj`;
- calibración por hablante: durante el enrolamiento se hace una validación cruzada en 5 bloques contiguos (se entrena con 4 y se mide la distancia del bloque restante); `delta_ref` es la mediana de esas distancias de voz propia no vista (mínimo 0,25);
- puntaje relativo `s = exp(-delta / (4,5 * delta_ref))` en (0, 1]: una trama típica de la docente puntúa alrededor de 0,80, cualquiera sea su variabilidad, el micrófono o la sala;
- coherencia de F0: el enrolamiento guarda el rango de F0 de la voz normal y la voz alta (percentiles 2 y 98). Una trama con F0 por encima de 1,25 veces el máximo o por debajo del mínimo dividido por 1,3 no se atribuye (motivo `f0_out_of_range`) y cuenta como puntaje 0 para el suavizado;
- suavizado temporal del puntaje (media móvil exponencial, peso 0,2 por trama, unos 0,2 s) con histéresis: se acepta con `s >= 0,65` (`delta <= 1,9 * delta_ref`) y se deja de aceptar con `s < 0,60` (`delta > 2,3 * delta_ref`); valores provisionales, ajustables con el umbral de similitud;
- estimación de calidad del perfil: la proporción de la voz propia reservada que el perfil atribuiría con el umbral vigente. Se muestra al enrolar y se registra en los parámetros del CSV como `ownAcceptance`, junto con `referenceDistance` y el rango de F0 (`f0Low`, `f0High`). Es conservadora, porque cada bloque se evalúa con un modelo entrenado con el 80 % del enrolamiento. Por debajo de 60 % se sugiere repetir el enrolamiento.

La versión 0.5.0 inicial usaba una escala absoluta (`s = exp(-delta / 3)`, aceptación con `delta <= 0,86`), ajustada con voces sintéticas cuyas vocales se repetían idénticas (`delta` propio de alrededor de 0,3). En voz real, una trama propia bien modelada tiene `delta` cercano a 1 o mayor, de modo que la mayor parte de la voz de la docente quedaba rechazada. La calibración por hablante corrige ese error.

La versión 0.3 usaba similitud coseno sobre los coeficientes sin estandarizar. Ese puntaje resultaba cercano a 1 para casi cualquier voz, porque el coseno ignora la magnitud y los primeros coeficientes son parecidos entre personas. En voces sintéticas (fuente glotal y formantes) aceptaba el 100 % de las tramas de una voz similar y también de una voz masculina.

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

Referencia con voces sintéticas (fuente glotal y formantes, 48 kHz, 30 s por voz, clasificador completo con los valores por defecto), con un perfil enrolado en voz normal y voz alta. La columna «estable» repite cada vocal idéntica; la columna «realista» varía los formantes y la inclinación espectral de cada vocal hasta ±10 % y su duración, como en el habla real. Porcentaje de tramas sonoras atribuidas a la docente:

| Voz evaluada | Estable | Realista (±10 %) |
|---|---|---|
| Docente, voz normal | 98 % | 99 % |
| Docente, F0 +15 % | 98 % | 95 % |
| Docente, F0 +35 % (grito) | 60 % | 95 % |
| Docente, F0 −15 % | 100 % | 100 % |
| Voz similar del mismo sexo (formantes +6 %, F0 +12 %) | 1 % | 96 % |
| Formantes +3 %, F0 +5 % | 99 % | 98 % |
| Otra mujer (formantes −8 %) | 0 % | 87 % |
| Niño o niña (F0 280 Hz, formantes +20 %) | 0 % | 1 % |
| Voz masculina | 0 % | 0 % |

Estimación de calidad del perfil: 81 % con voz estable y 100 % con voz realista. Los umbrales actuales priorizan atribuir la voz propia: con variabilidad realista, una voz adulta del mismo sexo y F0 parecida se atribuye casi siempre, y solo la coherencia de F0 la descarta cuando su tono queda fuera del rango enrolado.

Prueba de campo (2026-11-20, micrófono de celular, 50 s, la persona enrolada y otra voz hablando por turnos y a la vez). La voz enrolada tuvo F0 entre 111 y 149 Hz y la otra entre 194 y 453 Hz. El puntaje espectral separó ambas voces (AUC 0,91 trama a trama; mediana 0,74 la propia y 0,48 la otra), pero con aceptación en 0,75 y suavizado 0,05 solo se atribuyó el 28 % de la voz propia. Reproduciendo esa sesión con la regla actual:

| Regla | Voz propia | Otra voz |
|---|---|---|
| 0,75 / 0,70, suavizado 0,05 (anterior) | 28 % | 0 % |
| 0,65 / 0,60, suavizado 0,2, sin coherencia de F0 | 90 % | 21 % |
| 0,65 / 0,60, suavizado 0,2, máximo de F0 enrolado 150-170 Hz | 83-84 % | 0 % |
| 0,65 / 0,60, suavizado 0,2, máximo de F0 enrolado 190 Hz | 87 % | 14 % |

El 24 % de las tramas de esa sesión tuvo periodicidad insuficiente, sobre todo mientras hablaban las dos personas a la vez. Esas tramas no se atribuyen a nadie: con un único micrófono, el habla superpuesta subestima la dosis.

Conclusión: con variabilidad realista, el método separa de forma fiable las voces cuyo tono o tracto vocal difieren claramente (niños frente a un adulto, voces masculinas frente a femeninas y viceversa), pero no a otra persona adulta de timbre y tono parecidos. La variación entre vocales de una misma persona es comparable a la diferencia entre dos personas de tracto vocal similar.

Las pruebas `tests/speaker-verification.test.js` fijan una versión reducida de ambos escenarios (16 kHz).

Con estas características espectrales, dos voces con tractos vocales casi idénticos no se distinguen; para eso hace falta un modelo de embeddings de hablante entrenado (por ejemplo x-vector o ECAPA). Estos valores son sintéticos y no reemplazan la validación con voces reales.

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

### 10.1 Intensidad normalizada a la voz propia (sin calibración)

En el protocolo de estudio cada participante usa su propio celular, con una diadema del mismo tipo y marca a 1–2 cm de la boca, y no hay sonómetro. La sensibilidad de cada celular es distinta: con `I_k = (P_k / P_0)^2` sobre la amplitud digital, la misma voz en un celular 12 dB más sensible daba **16 veces** más dosis. Sin calibración acústica, la intensidad se normaliza a la voz normal de cada participante:

```text
I_k = (P_k / P_ref)^2 = 10^((L_k − L_ref) / 10)
```

- `L_ref` es la mediana del nivel de las tramas sonoras válidas de la **primera mitad del enrolamiento**, la de voz normal, según la guía. Se mide cada día, con la diadema ya colocada, porque el enrolamiento es obligatorio antes de iniciar. Una nueva calibración del ambiente la descarta junto con el perfil.
- La sensibilidad del celular afecta por igual a `P_k` y a `P_ref`, así que se cancela. `I = 1` es la voz normal de la persona, `I ≈ 4` equivale a +6 dB sobre ella y `I = 10` a +10 dB.
- Las unidades se rotulan `normalized`. `L_ref` se exporta como `ownVoiceRefDbfs` en los parámetros del CSV y como `ownVoiceRefDbfs` en la jornada; el CSV de los tableros lo incluye en `own_voice_ref_dbfs`.
- `H` depende solo de la fonación (§9), no de `I`, así que no cambia; las constantes de `f(H)` tampoco.
- Con esta normalización, `D_0` se lee como **ciclos equivalentes a voz normal**: hablar todo el día a voz normal da `D_0 = D_c`. Los modelos con memoria ponderan además por la carga reciente.
- Con calibración acústica se mantiene la presión en Pa (§10) y no se normaliza.

Interpretación y límites:

- La dosis normalizada mide el **esfuerzo relativo a la propia voz**, no la exposición acústica absoluta. Una persona cuya voz normal ya es fuerte aparece con `I ≈ 1` hablando así. La hipótesis de trabajo es que el esfuerzo relativo explica la fatiga. Se pone a prueba comparando qué exposición predice mejor ΔF, ΔE y ΔCPPS: `D_c`, `D_0` o los modelos con memoria.
- No permite un TLV de intensidad absoluto. Los límites transferibles en unidades físicas se derivan de `D_t` y `D_c`, que no dependen de la calibración.
- Un error en `L_ref` multiplica toda la jornada por `10^(error/10)`: 1 dB equivale a ×1,26 y 3 dB a ×2. Por eso hay que mantener estable la colocación de la diadema y enrolar con la voz habitual, no forzada. Conviene analizar `log(D_k)` y vigilar la estabilidad de `L_ref` de cada participante entre días.
- La normalización supone que el celular no aplica control automático de ganancia. Si lo aplica, el nivel deja de reflejar el esfuerzo (§4.2).
- La dosis de distancia `D_d` necesita SPL absoluto (sonómetro) y no está disponible en este protocolo. Su motor se conserva, pero la interfaz la oculta.
- Los tableros nunca mezclan unidades. Si hay jornadas guardadas con unidades distintas (`normalized`, `calibrated` o `relative`, por ejemplo jornadas de prueba anteriores a la 0.7.0), la barra de datos muestra un selector de unidades. Por defecto se muestran las de la jornada más reciente, y el contador indica cuántas jornadas quedaron fuera. Los registros sin unidades se toman como `relative`. El CSV de los tableros sigue exportando todas las jornadas, con su columna `units`.

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

### 12.1 Partitura vocal

La solapa **Partitura vocal** muestra la evolución temporal de toda la sesión como una partitura: seis pistas sincronizadas sobre un mismo eje de tiempo (hora del día desde el inicio de la sesión).

| Pista | Contenido | Nota |
|---|---|---|
| 1. `Φ(t)` | bloques de fonación atribuida y pausas | intensidad proporcional a la fracción de fonación de cada columna |
| 2. `F0` (Hz) | media de `F0` en la fonación | sin valores en las pausas; escala fija 75-350 Hz, ampliada si los datos la exceden |
| 3. `L_p` | nivel medio en la fonación, en dB SPL si la sesión está calibrada (40-110) o en dBFS (−70 a 0) | escala ampliada solo por los percentiles 2-98 de los datos |
| 4. `H(t)` (s) | estado de carga reciente | estado matemático del modelo, no fatiga medida |
| 5. `ΔD/Δt` | dosis ganada en cada columna dividida por el tiempo que cubre, por minuto | picos de acumulación; cero en las pausas |
| 6. `D` | dosis acumulada elegida: `D_0`, `D_L`, `D_P`, `D_E`, `D_S` o `D_d` (si la sesión la calcula) | siempre creciente o plana; mesetas en las pausas |

- Las pausas de 2 s o más se sombrean en todas las pistas; los intervalos con la sesión en pausa se muestran como huecos, nunca como datos.
- Al pasar el cursor, una línea vertical recorre las seis pistas y un recuadro muestra la hora y el valor de cada pista en ese instante.
- Los datos se guardan por trama y se reducen a una columna cada 2 píxeles antes de dibujar, para sostener una jornada completa. Mientras llegan tramas, la partitura se redibuja como máximo cada 0,7 s y solo si la solapa está visible.
- La solapa incluye la analogía musical (altura → `F0`, duración → fonación, dinámica → nivel, silencios → pausas, secuencia → historia de exposición `H`) y la advertencia "Modelo conceptual · validación pendiente".
- Las comparaciones entre jornadas y entre docentes están en las pestañas de tableros (§12.2-§12.5).

### 12.2 Registro de jornadas

El paso **Jornada (tableros)** guarda un resumen de cada sesión (`vd-des-workday/1`) en el navegador (IndexedDB). El resumen no contiene audio ni tramas; incluye:

- códigos seudónimos de docente, escuela y aula (letras, números, `.`, `-` o `_`, sin espacios ni nombres);
- fecha, inicio, duración y tiempo de fonación;
- todas las dosis (`D_0`, `D_L`, `D_P`, `D_E`, `D_S`, `D_d` si se calculó, `D_t`, `D_c`) y `H` final;
- percentiles 10, 50 y 90 de `F0` y del nivel;
- proporción de tiempo clasificado con certeza (calidad de la jornada);
- dosis acumuladas al final de cada minuto (línea de tiempo);
- eventos de contexto marcados por el docente durante la medición (llamado de atención, explicación, actividad grupal, recreo, otro) y eventos automáticos;
- fatiga vocal percibida antes y después de la jornada, en una escala visual analógica de 0 a 100 (desenlace primario del protocolo), optativas;
- versión del algoritmo y origen (`live`, `import` o `demo`).

**Autoguardado.** Mientras la sesión mide o está en pausa, la jornada se guarda sola en IndexedDB cada 2 minutos y además al pausar, al finalizar, ante una interrupción de la captura y al ocultar o cerrar la página (en este último caso, sin garantía de que la escritura termine). Es el mismo registro `vd-des-workday/1` con el mismo identificador, reemplazado en su lugar, más un campo optativo `checkpoint: { status, savedAt }`: `in_progress` mientras la sesión sigue y `recovered` cuando se encuentra al abrir la aplicación tras un cierre inesperado (se conserva, aparece en los tableros y se avisa una sola vez). El guardado manual escribe el registro final sin ese campo; los registros sin `checkpoint`, incluidos todos los anteriores, son finales. Las escrituras se hacen de a una, en orden, y el guardado manual siempre es la última. Si el docente cambia el código durante la sesión, se borra el autoguardado con el código anterior. Iniciar una sesión nueva sin haber guardado la anterior pide confirmación y descarta su autoguardado. El autoguardado necesita los códigos de docente, escuela y aula; sin ellos se avisa y no se guarda. Nunca guarda audio.

Cada jornada puede llevar además dos campos optativos para el envío a una base analítica (§14.1): `sessionUuid`, un UUID aleatorio de la sesión, y `deviceId`, un identificador aleatorio de la instalación.

Las jornadas se exportan e importan como JSON (`vd-des-workdays/1`) para reunir las de varios equipos; al importar se omiten los identificadores ya presentes y se informan los registros inválidos.

**Eventos automáticos (reglas provisionales):** fonación sostenida, cuando una ventana de 120 s tiene al menos 60 % de fonación (se recorta a sus bordes con voz); nivel elevado, cuando la voz supera durante 3 s o más la mediana de la propia jornada en 6 dB. Describen el patrón acústico; no identifican la actividad ni diagnostican fatiga.

### 12.3 Mi jornada

Vista del docente para una jornada elegida: fonación, tiempo observado, porcentaje de fonación, dosis de la jornada frente a su propia mediana, EVA pre y post, dosis acumulada y tasa por minuto con los eventos marcados, y la lista de eventos.

### 12.4 Dirección

Vista preventiva por escuela y semana. Los docentes aparecen solo por código, y **cualquier grupo de menos de 3 docentes se oculta** (aulas en el mapa y en la tabla, y la vista completa si la escuela tiene menos de 3 docentes esa semana). Incluye: KPI con variación respecto de la semana anterior; mapa de calor aula × día con la dosis media (rampa azul de un solo tono y el valor en cada celda); docentes con EVA pre media ≥ 30; carga por aula con su estado frente a los niveles de acción; distribución de la EVA pre y post; percentiles 10, 50 y 90 de la EVA pre por día; y la jornada de un docente con sus eventos, sujeta a autorización.

### 12.5 Analítica

Vista de investigación sobre todas las jornadas disponibles:

- KPI (participantes, jornadas recibidas y válidas, escuelas, última recepción, calidad global) y participación mensual;
- distribución de la dosis elegida y del cambio de EVA (post − pre), con n, media, mediana, DE, P25, P75 y P95 (cuantiles tipo 7);
- últimas jornadas recibidas;
- dosis-respuesta: regresión lineal (OLS) del cambio de EVA sobre la dosis, con banda de confianza al 95 % de la media (t de Student exacta), R² y rho de Spearman;
- curvas ROC de cada modelo para el caso **cambio de EVA ≥ umbral** (configurable, 20 puntos por defecto y provisional, porque el protocolo exige fijar la magnitud mínima relevante antes de analizar), con AUC de Mann-Whitney e intervalo de Hanley-McNeil al 95 %;
- en el corte de Youden (empates a la mayor sensibilidad): sensibilidad, especificidad, VPP y VPN con intervalos de Wilson al 95 %;
- niveles de acción provisionales: C1 = corte de Youden y C2 = menor corte con especificidad ≥ 0,90, con zonas baja, media y alta, siempre con ícono y texto;
- exportación de los resúmenes en CSV.

Las AUC son aparentes (misma muestra); la validación agrupada por docente, los modelos mixtos y los splines quedan para el análisis definitivo. Todas las pantallas indican "Valores provisionales · sin umbrales sanitarios validados".

**Datos simulados:** un conjunto reproducible (3 escuelas, aulas de al menos 3 docentes, 4 semanas hábiles, ausencias y EVA faltantes) permite ver los tableros sin datos reales. Siempre se muestra con el aviso "DATOS SIMULADOS" y nunca se mezcla con las jornadas guardadas. La fatiga simulada sigue la hipótesis nula del protocolo (la memoria no aporta), de modo que ningún modelo resulta favorecido por construcción: la demo no es evidencia.

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

Con dosis de distancia, los parámetros incluyen `ddProfile`, `ddOffsetDb`, `ddOffsetSource` (`measured` o `inverse_distance`) y, si corresponde, `ddMouthDistanceM`. Con calibración, los parámetros incluyen `calRefDbSpl` y `calCoefficient`. Tras la verificación posterior se agregan `calPostCoefficient`, `calDriftPct`, `calDriftDb` y `calWithinTolerance`, que se incluyen al exportar.

**Parámetros una sola vez (desde 0.8.0).** La columna `parameters` conserva su posición, pero solo la primera fila de datos trae el valor; en las demás filas la celda queda vacía. Los parámetros son los mismos para toda la sesión, así que para cada fila valen los de la primera. Antes de 0.8.0 se repetían en todas las filas, unos 500 caracteres por trama: en una jornada de 8 h el CSV y la memoria de la sesión pasaban de unos 490 MB a unos 140 MB con este cambio. Quien lea los parámetros de una fila cualquiera, por ejemplo después de filtrar, debe tomarlos de la primera fila. La versión del algoritmo (`algorithm_version`) permite distinguir ambos formatos.

Las columnas nuevas se agregan al final para no alterar la posición de las existentes.

**Exportación comprimida (opcional).** Por defecto se descarga el `.csv` sin comprimir. Con la casilla «Comprimir (.csv.gz)» se descarga el mismo CSV comprimido con gzip (`application/gzip`): al descomprimirlo es idéntico byte a byte al `.csv`, y una jornada de 8 h pasa de unos 148 MB a unos 26 MB. R (`read.csv`, `readr`) y pandas lo leen sin descomprimir; las planillas necesitan descomprimirlo antes. Si el navegador no tiene `CompressionStream`, la casilla queda deshabilitada; si la compresión falla, se descarga el `.csv` sin comprimir y se avisa. La exportación arma el archivo por bloques de 10 000 filas, sin un texto único del tamaño del documento.

La conservación de scores continuos permite recalcular decisiones con nuevos umbrales sin repetir la medición.

## 14. Privacidad

- El procesamiento se realiza localmente.
- El audio no se conserva por defecto.
- La evaluación acústica PRE–POST (§23) tampoco conserva audio: cada muestra se analiza en memoria y se borra. Solo se guardan medidas y dos espectros promediados (LTAS y cepstro medio), de los que no se puede reconstruir la voz ni lo dicho.
- La plantilla del hablante puede mantenerse en memoria o guardarse localmente.
- La plantilla debe considerarse un dato sensible.
- Para investigación con personas se requiere consentimiento informado y revisión ética.
- La base analítica debe utilizar identificadores codificados.
- Las jornadas guardadas contienen solo resúmenes y códigos, quedan en el navegador del equipo y se pueden exportar o borrar desde la barra de datos.
- Los tableros nunca muestran nombres y ocultan los grupos de menos de 3 docentes.

### 14.1 Envío opcional a una base analítica

El envío de resúmenes a una base de datos que alimente un tablero analítico es **optativo y está desactivado por defecto**. Se activa en cada equipo (*opt-in*), solo con consentimiento informado y con la aprobación ética del protocolo que lo prevea. Sin esa activación, nada sale del navegador.

**Qué se envía.** Solo el resumen de la jornada (`vd-des-workday/1`). El contrato es una lista cerrada de campos (`SYNC_FIELDS`, `src/store/workday-sync.js`):

- identificación: `schema`, `id` y, si existen, `sessionUuid` y `deviceId`;
- códigos seudónimos: `participantId`, `schoolId`, `classroom`;
- jornada: `date`, `startedAt`, `durationS`, `phonationS`, `validRatio`;
- carga: `doses`, `hMax`, percentiles de `f0` y `level`, `units`, `ownVoiceRefDbfs`, `timeline` (dosis por minuto);
- contexto: `events` (incluidas las interrupciones de captura), `fatigue`, `assessment` (EVA y medidas PRE–POST, sin audio);
- procedencia: `algorithmVersion`, `source` y, si corresponde, `checkpoint`.

Todo campo fuera de la lista se descarta al armar el envío y se rechaza al recibirlo.

**Qué no se envía nunca.**

- Audio, ni crudo ni filtrado.
- Tramas: el CSV por trama solo se exporta a mano (§13).
- La plantilla del hablante (prototipos, distancias, rango de F0 del enrolamiento).
- Nombres ni datos de contacto.

Como resguardo, el contrato rechaza cualquier arreglo de más de 100 valores numéricos fuera de la línea de tiempo por minuto, que tiene como máximo 1440 valores.

**Qué jornadas se envían.** Solo las guardadas y las recuperadas tras un cierre inesperado; estas llegan marcadas con `checkpoint.status = recovered`. Una sesión en curso (`in_progress`) nunca se envía.

**Identidad y duplicados.**

- `sessionUuid` es un UUID aleatorio de la sesión y es la clave de idempotencia: reenviar la misma jornada la reemplaza, no la duplica. Si falta, se usa `id`.
- `deviceId` es un identificador aleatorio de la instalación, nunca un identificador del hardware.
- Ambos campos son optativos y no cambian la versión del esquema: los registros anteriores siguen siendo válidos.

**Formato.** El envío usa el mismo sobre que la exportación JSON (`vd-des-workdays/1`: `format`, `exportedAt`, `workdays`), así que un archivo exportado a mano y un envío se cargan igual. Para el servidor se publica un JSON Schema del registro (`WORKDAY_SYNC_JSON_SCHEMA`). La referencia es el validador `validateSyncRecord`, que además aplica el resguardo contra contenido de audio.

**En la base analítica.**

- Se usan solo códigos.
- Los tableros mantienen la supresión de grupos de menos de 3 docentes.
- Se debe poder borrar todo lo asociado a un código si la persona retira su consentimiento.
- El transporte (HTTP, autenticación) y el proveedor quedan fuera de este contrato.

**Cola de envío y reintentos.** La base local pasa a la versión 2, que agrega el almacén `outbox`. La migración desde la versión 1 solo crea ese almacén y conserva intactas las jornadas guardadas. Si otra pestaña tiene abierta la versión anterior, se pide cerrarla y recargar.

- Al guardar una jornada final medida en el equipo (`source = live`), ya sea con «Guardar jornada» o al cerrar el autoguardado, se encola su registro de envío.
- También se encolan las jornadas recuperadas.
- No se encolan los autoguardados en curso ni las jornadas importadas o de demostración.
- Si falla el encolado, el guardado local sigue siendo válido: se avisa y la jornada queda en el equipo.
- El servicio de envío (`src/store/sync-service.js`) toma de a una las jornadas pendientes cuyo turno llegó, solo con conexión, y nunca hace dos rondas a la vez.
- Ante un error transitorio reintenta con espera exponencial: base × 2^(intento − 1), con un máximo; por defecto, 30 s y 1 h. Le suma una variación aleatoria entre la mitad y el total, para que los equipos no reintenten todos juntos.
- Si el servidor rechaza el registro de forma definitiva, deja de reintentar y lo marca como rechazado.
- Al recibir un registro nuevo de la misma sesión, el anterior se reemplaza y los reintentos vuelven a cero.
- Borrar una jornada local, o todas desde la barra de datos, cancela también sus envíos pendientes: lo que se borra no se sube.
- Cada comprobación sobre la cola o sobre el resumen local se hace en el mismo paso que la escritura (una sola transacción), así que un guardado de la misma sesión durante un envío nunca se pierde ni se borra.

**Borrado local tras el envío.** El resumen local se borra solo cuando el servidor confirma el envío, y solo si sigue siendo exactamente el registro enviado. Si cambió mientras se enviaba, se conserva y se envía la versión nueva. Con el envío pendiente, fallido o rechazado, el resumen y su lugar en la cola se conservan. Las jornadas enviadas y borradas dejan de verse en los tableros locales: desde ese momento se consultan en el tablero de la base analítica. El borrado se puede desactivar (`purgeAfterSync: false`).

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
| 0.6.0 | 2026-11-20 | Evaluación acústica PRE–POST (§23): /a/ sostenida y texto estándar analizados en memoria y borrados; F0, CPP/CPPS, HNR, LTAS, cepstro medio, jitter y shimmer exploratorios; EVA de esfuerzo, molestia y sequedad; registro `VOICE_ACOUSTIC_ASSESSMENT` |
| 0.7.0 | 2026-11-22 | Intensidad normalizada a la voz propia sin calibración (§10.1): `I = 1` a la voz normal del enrolamiento, dosis comparables entre celulares, `ownVoiceRefDbfs` en la jornada y en los CSV; `D_d` oculta en la interfaz |
| 0.8.0 | 2026-11-22 | Captura que avisa y pausa ante micrófono perdido, audio suspendido o página oculta, con wake lock; autoguardado periódico de la jornada con recuperación tras cierre inesperado (§12.2); `parameters` del CSV solo en la primera fila (§13); exportación del CSV por bloques de 10 000 filas, sin un texto único del tamaño del documento, y exportación optativa comprimida `.csv.gz` (§13); contrato de envío de resúmenes de jornada a una base analítica, con `sessionUuid` y `deviceId` optativos (§14.1) |

## 23. Evaluación acústica PRE–POST

Evaluación breve y estandarizada al comienzo y al final de la jornada, distinta de la dosimetría continua. Aporta una tercera fuente de datos, independiente de las otras dos:

| Dimensión | Qué mide | Variables |
|---|---|---|
| Exposición | Cómo se usó la voz | `D_k`, F0, intensidad, fonación, pausas |
| Respuesta subjetiva | Cómo percibe la persona su voz | ΔF (fatiga), ΔE (esfuerzo), molestia, sequedad |
| Respuesta acústica | Si cambió objetivamente la señal vocal | ΔCPPS, ΔHNR, ΔF0 y otras |

La salida se denomina **«Cambio acústico PRE–POST»**, nunca «fatiga»: un cambio acústico no equivale a fatiga, y puede haber fatiga sin cambio acústico detectable. Los valores se muestran de forma descriptiva y sin puntos de corte clínicos durante la fase experimental.

### 23.1 Protocolo

En PRE y en POST se repite exactamente lo mismo: las mismas preguntas, la misma vocal, el mismo texto, el mismo celular y micrófono, la misma distancia y postura boca–micrófono, y el mismo algoritmo.

1. EVA 0-100 de fatiga, esfuerzo, molestia y sequedad.
2. Vocal /a/ sostenida, cómoda, a tono y volumen habituales: toma de 5 s.
3. Lectura del texto estándar en voz de clase: toma de 25 s. El texto lleva unos 20 s y el silencio final se descarta como pausa.

Cada toma empieza con 1 s de silencio, que sirve de referencia de ruido. El micrófono debe estar conectado y libre: la toma no se puede hacer mientras se mide la jornada.

Texto estándar (`viento-norte-sol-v1`): redacción propia del proyecto de la fábula de Esopo «El viento norte y el sol», el pasaje que se usa en las ilustraciones fonéticas del Manual de la AFI.

> El viento norte y el sol discutían cuál de los dos era el más fuerte, cuando vieron pasar a un viajero envuelto en una capa. Acordaron que ganaría quien lograra que el viajero se la quitara. El viento sopló con toda su fuerza, pero cuanto más soplaba, más se abrigaba el viajero. Entonces el sol brilló con calor y el viajero, sofocado, se quitó la capa. Así, el viento tuvo que reconocer que el sol era el más fuerte.

### 23.2 Analizar y borrar

El dosímetro no graba voz. La toma existe solo en memoria. Con Web Workers se transfiere al hilo de análisis, de modo que la página deja de tenerla; al terminar se sobrescribe con ceros. Una toma cancelada también se borra. La toma nunca se escribe en el almacenamiento, en el CSV ni en la red. Cada resultado lleva `audioRetained = false`, y los registros que digan lo contrario se rechazan.

Como no se conserva audio, las medidas no se pueden recalcular si el algoritmo cambia. Por eso la versión del algoritmo y todos los parámetros de análisis se exportan con cada fila, y el método debe validarse contra Praat antes del uso de campo (§23.6). Se guardan además dos resúmenes promediados en el tiempo: el LTAS en bandas de 1/3 de octava desde 100 Hz, en dB relativos al total, y el cepstro suavizado medio entre 1 y 20 ms, cada 0,25 ms. Permiten recalcular algunas medidas espectrales y cepstrales, pero no el jitter ni el shimmer.

### 23.3 Medidas

El análisis se hace a 16 kHz (diezmado entero con filtro antialias); jitter y shimmer usan la frecuencia original de grabación.

| Medida | Método | Tarea |
|---|---|---|
| F0 media, mediana, DE (Hz y semitonos), p5–p95 y rango en semitonos | YIN del proyecto (70-500 Hz, ventanas de 40 ms cada 10 ms); se excluyen las pausas por nivel | /a/ y texto |
| Confianza de pitch | Periodicidad media de YIN en las tramas sonoras | /a/ y texto |
| CPP | Hillenbrand. Preénfasis desde 50 Hz, Hann de 3/60 s, paso de 2 ms, pico entre 1/330 y 1/60 s, recta de tendencia por mínimos cuadrados desde 1 ms hasta el final del cepstro; promedio por trama | /a/ y texto |
| CPPS | Igual que CPP, sobre el cepstro suavizado 10 ms en el tiempo y 1 ms en la quefrencia | /a/ y texto |
| HNR | Correlación cruzada normalizada al período local, en ventanas de 3 períodos: `10·log10(r/(1−r))` | /a/ y texto |
| Jitter local (%) | Marcas de ciclo por coincidencia de forma de onda, `mean|T_i − T_{i+1}| / mean T`, con los límites de Praat: 0,1-20 ms y factor 1,3 | Solo /a/, exploratorio |
| Shimmer local (%) | Amplitud pico a pico por ciclo, `mean|A_i − A_{i+1}| / mean A`, factor 1,6 | Solo /a/, exploratorio |
| Nivel | dBFS, o dB SPL si el micrófono está calibrado (§10) | /a/ y texto |

Se prioriza CPPS por sobre jitter y shimmer: estos dos exigen una señal periódica y solo son apropiados en la vocal sostenida.

### 23.4 Control de calidad inmediato

Una toma defectuosa se detecta en el momento y se pide repetirla, porque no queda audio para revisar después.

- SNR (nivel sonoro menos el nivel del silencio inicial): se rechaza por debajo de 20 dB y se advierte por debajo de 30 dB. El ruido se mide como el percentil 20 de las tramas del silencio inicial, sin sus primeros 150 ms. Así, el toque del botón o una voz que arranca un poco antes no cuentan como ruido de fondo. Si la voz ocupa la mitad o más del silencio inicial, el rechazo dice que se empezó antes de tiempo (`voice_in_lead_in`), en lugar de culpar al ruido. La interfaz pide silencio y muestra «¡Ahora!» al terminar ese segundo. El mensaje de rechazo informa el SNR medido.
- Saturación: se rechaza si más del 0,1 % de las muestras llega a fondo de escala.
- Voz mínima: 2 s sonoros en la /a/ y 5 s en el texto.

Las tomas rechazadas no se guardan. Las tomas con advertencia se guardan con esa marca.

### 23.5 Datos y exportación

Las EVA y los resultados se guardan en el navegador durante el día, para que el PRE de la mañana siga disponible en el POST. Al guardar la jornada pasan al registro `vd-des-workday/1`, en el campo `assessment`; la fatiga sigue en `fatigue`. El botón «Exportar evaluación (CSV)» genera el registro VD-DES `VOICE_ACOUSTIC_ASSESSMENT`, con una fila por momento (PRE/POST) y tarea (VOWEL/SPEECH). Cada fila incluye las medidas, la calidad de señal, la versión del algoritmo, los parámetros de pitch y cepstrales, la frecuencia de muestreo, el micrófono, la calibración, `audio_retained`, el LTAS y el cepstro medio.

### 23.6 Validez y uso científico

- Los valores son los de esta implementación. ANAGRAF y Praat no dan valores intercambiables: coinciden en F0, pero difieren en jitter, shimmer y HNR, sobre todo en voces irregulares. Antes de comparar con normas publicadas hay que validar contra Praat, con grabaciones de laboratorio de voluntarios (concordancia, por ejemplo mediante CCI). Esa validación no se hace con docentes reales.
- En las señales sintéticas de prueba (`tests/voice-assessment.test.js` y `tests/voice-perturbation.test.js`):
  - el ruido agregado baja CPP y CPPS;
  - el HNR sigue al ruido agregado (±3 dB a 10 dB);
  - las pausas no alteran el CPPS;
  - un jitter de σ = 1 % se mide como 0,9 % y un shimmer de σ = 5 % como 4,1 %, porque cada ciclo medido mezcla dos ciclos sintéticos.
- El cambio ΔA = A_POST − A_PRE se estudia primero variable por variable (`D_k` → ΔF, ΔE, ΔCPPS, ΔHNR, ΔF0). Un índice combinado se construiría después, con coeficientes estimados en una cohorte de desarrollo y validados externamente, nunca con pesos arbitrarios.
