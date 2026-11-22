// Runs the PRE/POST acoustic analysis off the main thread (a 20 s text takes seconds on a
// phone). The samples arrive transferred, so the page no longer holds them; they are
// zeroed here once analysed and only the measures go back.
import { analyseVoiceSample } from '../dsp/voice-assessment.js';

self.onmessage = ({ data }) => {
  const { samples, sampleRate, options } = data;
  try {
    self.postMessage({ result: analyseVoiceSample(samples, sampleRate, options) });
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    samples.fill(0);
  }
};
