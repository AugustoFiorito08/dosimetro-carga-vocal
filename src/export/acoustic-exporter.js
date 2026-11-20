// VD-DES record VOICE_ACOUSTIC_ASSESSMENT (spec §17): one CSV row per timepoint × task.
// Method, version and analysis settings go with every row, because values from different
// tools (ANAGRAF, Praat, this one) are not interchangeable.
import { ALGORITHM_VERSION, formatNumber, serializeCsvRow, serializeParameters } from './csv-exporter.js';
import { TASKS, TIMEPOINTS } from '../store/voice-assessment.js';

export const ACOUSTIC_RECORD_TYPE = 'VOICE_ACOUSTIC_ASSESSMENT';

export const ACOUSTIC_CSV_COLUMNS = Object.freeze([
  'record_type',
  'participant_id',
  'date',
  'timepoint',
  'task',
  'text_id',
  'f0_mean_hz',
  'f0_median_hz',
  'f0_sd_hz',
  'f0_sd_st',
  'f0_p5_hz',
  'f0_p95_hz',
  'f0_range_st',
  'pitch_confidence',
  'voiced_s',
  'cpp_db',
  'cpps_db',
  'hnr_db',
  'jitter_local_pct',
  'shimmer_local_pct',
  'level_dbfs',
  'spl_db',
  'snr_db',
  'clip_fraction',
  'signal_quality',
  'quality_reasons',
  'algorithm_version',
  'pitch_settings',
  'cepstral_settings',
  'sample_rate_hz',
  'analysis_sample_rate_hz',
  'microphone',
  'calibrated',
  'audio_retained',
  'ltas_centers_hz',
  'ltas_db',
  'cepstrum_from_s',
  'cepstrum_step_s',
  'cepstrum_db',
]);

const list = (values) => (values ? values.map(formatNumber).join(' ') : '');

/**
 * @param {ReturnType<import('../store/voice-assessment.js').createAssessment>} state
 * @param {{ participantId: string, microphone?: string, algorithmVersion?: string }} meta
 */
export function buildAcousticCsv(state, { participantId, microphone = '', algorithmVersion = ALGORITHM_VERSION }) {
  const rows = [];
  for (const timepoint of TIMEPOINTS) {
    for (const task of TASKS) {
      const r = state[timepoint][task];
      if (!r) continue;
      const n = formatNumber;
      rows.push(serializeCsvRow([
        ACOUSTIC_RECORD_TYPE,
        participantId,
        state.date,
        timepoint,
        task,
        task === 'SPEECH' ? state.textId : '',
        n(r.f0?.mean), n(r.f0?.median), n(r.f0?.sd), n(r.f0?.sdSemitones), n(r.f0?.p5), n(r.f0?.p95), n(r.f0?.rangeSemitones),
        n(r.pitchConfidence),
        n(r.voicedSeconds),
        n(r.cpp), n(r.cpps), n(r.hnr),
        n(r.jitterLocal), n(r.shimmerLocal),
        n(r.levelDbfs), n(r.splDb), n(r.snrDb), n(r.clipFraction),
        r.quality.status,
        r.quality.reasons.join(' '),
        algorithmVersion,
        serializeParameters(r.settings.pitch),
        serializeParameters(r.settings.cepstral),
        n(r.settings.sampleRate),
        n(r.settings.analysisSampleRate),
        microphone,
        r.splDb !== null ? 'true' : 'false',
        String(r.audioRetained),
        list(r.ltas?.centersHz), list(r.ltas?.db),
        n(r.cepstrum?.fromSeconds), n(r.cepstrum?.stepSeconds), list(r.cepstrum?.db),
      ]));
    }
  }
  return [serializeCsvRow(ACOUSTIC_CSV_COLUMNS), ...rows].join('\r\n') + '\r\n';
}
