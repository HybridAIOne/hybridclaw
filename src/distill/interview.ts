import type { DistillPaths } from './paths.js';
import { loadDistillState } from './state.js';
import type { PersonaDimension, SubjectProfile } from './types.js';
import { PERSONA_DIMENSIONS } from './types.js';

export type InterviewAudience = 'subject' | 'colleague';

interface QuestionPair {
  subject: string;
  colleague: string;
}

const QUESTION_BANK: Record<PersonaDimension, QuestionPair[]> = {
  identity: [
    {
      subject:
        'How would you describe what you actually do — not the job title, the real job?',
      colleague:
        'What does {name} actually do day to day — not the job title, the real job?',
    },
    {
      subject:
        'What do colleagues come to you for that they could not get from anyone else?',
      colleague:
        'What do people go to {name} for that they could not get from anyone else?',
    },
    {
      subject: 'What part of your work do you consider non-negotiably yours?',
      colleague: 'What work would feel wrong to take away from {name}?',
    },
  ],
  expression: [
    {
      subject:
        'How do you usually open and close a message to a colleague? Show a typical example.',
      colleague:
        'How does a typical message from {name} read? What would never appear in one?',
    },
    {
      subject:
        'What phrases or formatting habits do people tease you about or recognize you by?',
      colleague:
        'What phrases or habits make you instantly recognize {name} wrote something?',
    },
    {
      subject: 'When you disagree in writing, what does that look like?',
      colleague: 'How does {name} sound when they disagree in writing?',
    },
  ],
  'decision-making': [
    {
      subject:
        'Walk through a recent decision you are proud of. What did you weigh, and what did you ignore?',
      colleague:
        'Describe a decision {name} made that stuck with you. What did they weigh?',
    },
    {
      subject:
        'What do you decide instantly, and what do you always sleep on or escalate?',
      colleague:
        'What does {name} decide instantly, and what do they escalate?',
    },
    {
      subject: 'What kind of evidence changes your mind? What kind never does?',
      colleague: 'What does it take to change {name}’s mind?',
    },
  ],
  interpersonal: [
    {
      subject: 'How do you deliver criticism? Give a real example if you can.',
      colleague: 'How does {name} deliver criticism?',
    },
    {
      subject: 'In meetings, when do you speak up and when do you stay quiet?',
      colleague: 'What role does {name} play in meetings?',
    },
    {
      subject: 'Who do you defer to, and on what topics?',
      colleague: 'Who does {name} defer to, and on what?',
    },
  ],
  experience: [
    {
      subject:
        'Which projects or systems do you know inside out, and what did they teach you?',
      colleague: 'Which projects or systems does {name} know inside out?',
    },
    {
      subject:
        'What is a hard-won lesson you find yourself repeating to others?',
      colleague: 'What lesson does {name} keep repeating to others?',
    },
    {
      subject: 'What would break first if you left tomorrow?',
      colleague: 'What would break first if {name} left tomorrow?',
    },
  ],
  correction: [
    {
      subject: 'What do people consistently get wrong about how you work?',
      colleague:
        'What would {name} say people consistently get wrong about them?',
    },
    {
      subject:
        'If a clone of you started tomorrow, what is the first bad habit you would warn it against?',
      colleague:
        'If a clone of {name} started tomorrow, what would you warn it against?',
    },
  ],
};

/**
 * Gap-driven questionnaire (the interview modality): dimensions with the
 * least standing evidence get asked first, so each interview round targets
 * what the corpus has not yet shown. Answers are saved as an `interview`
 * source (weight 1.0) and feed the next analyse cycle.
 */
export function generateQuestionnaire(
  paths: DistillPaths,
  profile: SubjectProfile,
  options: { audience?: InterviewAudience; count?: number } = {},
): string {
  const audience = options.audience || 'subject';
  const count = Math.max(1, Math.min(20, options.count ?? 8));
  const state = loadDistillState(paths);
  const coverage = new Map<PersonaDimension, number>(
    PERSONA_DIMENSIONS.map((dimension) => [
      dimension,
      state.claims.filter(
        (claim) => claim.dimension === dimension && claim.status === 'standing',
      ).length,
    ]),
  );
  const ordered = [...PERSONA_DIMENSIONS].sort(
    (a, b) => (coverage.get(a) || 0) - (coverage.get(b) || 0),
  );
  const questions: { dimension: PersonaDimension; text: string }[] = [];
  let round = 0;
  while (questions.length < count && round < 10) {
    for (const dimension of ordered) {
      const bank = QUESTION_BANK[dimension];
      const pair = bank[round % bank.length];
      if (round >= bank.length) continue;
      const text = (
        audience === 'subject' ? pair.subject : pair.colleague
      ).replace(/\{name\}/g, profile.displayName);
      questions.push({ dimension, text });
      if (questions.length >= count) break;
    }
    round += 1;
  }
  const intro =
    audience === 'subject'
      ? `_Answer in your own voice — half-sentences and tangents welcome. The more it sounds like you, the better the distillation._`
      : `_Answer about ${profile.displayName} as honestly as you can. Concrete stories beat adjectives._`;
  const lines: string[] = [
    `# Distillation Interview — ${profile.displayName}`,
    '',
    intro,
    '',
    `_Save the completed file, then ingest it with:_`,
    `\`hybridclaw coworker sources add --alias ${paths.subject} --kind interview <this-file>\``,
    '',
  ];
  questions.forEach((question, index) => {
    lines.push(
      `**Q${index + 1} (${question.dimension}):** ${question.text}`,
      '',
      '**A:**',
      '',
    );
  });
  return lines.join('\n');
}
