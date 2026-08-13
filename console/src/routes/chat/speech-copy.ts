/**
 * Webchat speech copy — the localized labels and status text for audio UX.
 *
 * Locale selection follows the browser because the console has no global
 * translation runtime; the same locale is also passed to speech synthesis.
 *
 * NOT a general console i18n registry; it deliberately covers only dictation
 * and read-aloud controls.
 */

export interface SpeechCopy {
  cancelDictation: string;
  dictate: string;
  listening: string;
  micDenied: string;
  micFailed: string;
  micUnsupported: string;
  micUnavailable: string;
  noSpeech: string;
  preparingSpeech: string;
  read: string;
  readFailed: string;
  readUnsupported: string;
  readUnavailable: string;
  reading: string;
  requestingMic: string;
  stopDictation: string;
  stopReading: string;
  transcribing: string;
}

const ENGLISH: SpeechCopy = {
  cancelDictation: 'Cancel voice input',
  dictate: 'Voice input',
  listening: 'Just start speaking…',
  micDenied:
    'No access to the microphone. Please allow it in your browser settings.',
  micFailed: 'The recording could not be transcribed. Please try again.',
  micUnsupported: 'Your browser does not support voice input.',
  micUnavailable: 'Voice input requires an audio transcription backend.',
  noSpeech: 'No speech was detected. Please try again.',
  preparingSpeech: 'Preparing audio…',
  read: 'Read response aloud',
  readFailed: 'The response could not be read aloud. Please try again.',
  readUnsupported: 'Your browser does not support read aloud.',
  readUnavailable: 'Read aloud requires a HybridAI or OpenAI API key.',
  reading: 'Reading response aloud…',
  requestingMic: 'Requesting microphone access…',
  stopDictation: 'Stop recording',
  stopReading: 'Stop reading response',
  transcribing: 'Transcribing…',
};

const GERMAN: SpeechCopy = {
  cancelDictation: 'Spracheingabe abbrechen',
  dictate: 'Spracheingabe',
  listening: 'Sprechen Sie einfach los…',
  micDenied:
    'Kein Zugriff auf das Mikrofon. Bitte erlauben Sie ihn in Ihren Browsereinstellungen.',
  micFailed:
    'Die Aufnahme konnte nicht transkribiert werden. Bitte versuchen Sie es erneut.',
  micUnsupported: 'Ihr Browser unterstützt keine Spracheingabe.',
  micUnavailable:
    'Für Spracheingabe ist ein Audio-Transkriptionsdienst erforderlich.',
  noSpeech: 'Es wurde keine Sprache erkannt. Bitte versuchen Sie es erneut.',
  preparingSpeech: 'Audio wird vorbereitet…',
  read: 'Antwort vorlesen',
  readFailed:
    'Die Antwort konnte nicht vorgelesen werden. Bitte versuchen Sie es erneut.',
  readUnsupported: 'Ihr Browser unterstützt kein Vorlesen.',
  readUnavailable:
    'Für Vorlesen ist ein HybridAI- oder OpenAI-API-Schlüssel erforderlich.',
  reading: 'Antwort wird vorgelesen…',
  requestingMic: 'Mikrofonzugriff wird angefragt…',
  stopDictation: 'Aufnahme stoppen',
  stopReading: 'Vorlesen stoppen',
  transcribing: 'Wird transkribiert…',
};

const FRENCH: SpeechCopy = {
  cancelDictation: 'Annuler la saisie vocale',
  dictate: 'Saisie vocale',
  listening: 'Commencez simplement à parler…',
  micDenied:
    "Aucun accès au microphone. Veuillez l'autoriser dans les réglages de votre navigateur.",
  micFailed: "L'enregistrement n'a pas pu être transcrit. Veuillez réessayer.",
  micUnsupported: 'Votre navigateur ne prend pas en charge la saisie vocale.',
  micUnavailable:
    'La saisie vocale nécessite un service de transcription audio.',
  noSpeech: "Aucune parole n'a été détectée. Veuillez réessayer.",
  preparingSpeech: 'Préparation de l’audio…',
  read: 'Lire la réponse à voix haute',
  readFailed:
    "La réponse n'a pas pu être lue à voix haute. Veuillez réessayer.",
  readUnsupported:
    'Votre navigateur ne prend pas en charge la lecture à voix haute.',
  readUnavailable:
    'La lecture à voix haute nécessite une clé API HybridAI ou OpenAI.',
  reading: 'Lecture de la réponse…',
  requestingMic: "Demande d'accès au microphone…",
  stopDictation: "Arrêter l'enregistrement",
  stopReading: 'Arrêter la lecture',
  transcribing: 'Transcription…',
};

export function getSpeechCopy(language?: string): SpeechCopy {
  const locale = (language || '').trim().toLowerCase().split('-')[0];
  if (locale === 'de') return GERMAN;
  if (locale === 'fr') return FRENCH;
  return ENGLISH;
}
