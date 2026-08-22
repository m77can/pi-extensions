/**
 * pi-ask contract — pure, dependency-free core of the questionnaire tool:
 * typebox schema, runtime validation, and the LLM-facing envelope builder.
 *
 * Kept free of relative imports so plain `node --test` can import this module
 * directly (the extension entry imports shared/*.js which only pi's jiti
 * loader can map).
 */
import { Type } from "typebox";

// ── Limits & schema (model-facing contract, mirroring upstream) ────────────

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: `The available choices for this question. Must have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.`,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	),
	ui: Type.Optional(
		Type.Object({
			customRow: Type.Optional(
				Type.String({
					description:
						'Label of the free-text row users open to type a custom answer, phrased in the user\'s language, max ~20 characters. Default: "Type something."',
				}),
			),
			submit: Type.Optional(
				Type.String({
					description:
						'Label of the done button on multi-select questions, phrased in the user\'s language, max ~20 characters. Default: "[Done]".',
				}),
			),
			inputPrompt: Type.Optional(
				Type.String({
					description:
						'Prefix shown before the text the user is typing, phrased in the user\'s language, max ~10 characters. Default: "Type: ".',
				}),
			),
			hint: Type.Optional(
				Type.String({
					description:
						"Bottom help line describing the available keys, phrased in the user's language, max ~50 characters. Write only the action words (e.g. 'move / choose / next / cancel').",
				}),
			),
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "Questions to ask the user (1-4 questions)",
});

export const ParametersSchema = Type.Object({ questions: QuestionsSchema });

// ── Contract types ─────────────────────────────────────────────────────────

export interface QuestionUi {
	customRow?: string;
	submit?: string;
	inputPrompt?: string;
	hint?: string;
}

export interface QuestionParams {
	questions: {
		question: string;
		header: string;
		options: { label: string; description: string; preview?: string }[];
		multiSelect?: boolean;
		ui?: QuestionUi;
	}[];
}

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	globalNote?: string;
}

// ── Tool definition (English, model-facing) ───────────────────────────────

export const TOOL_DESCRIPTION =
	"Ask the user one or more structured questions when you need clarification or a decision before proceeding, instead of guessing. Each question shows 2-4 predefined options plus an automatically appended 'Type something.' row for custom answers. IMPORTANT: option labels must be concise (1-5 words); every option needs a description explaining the choice and its trade-offs; set multiSelect: true when multiple answers are valid; if you recommend one option, make it the first option. Do NOT author 'Other' or 'Type something.' options yourself — reserved labels are rejected at runtime. Pressing Esc abandons the questionnaire — treat the returned cancelled result as an explicit decline.";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX =
	"You can now continue with the user's answers in mind.";

export function buildAnswerSegment(a: QuestionAnswer): string {
	const scalar =
		a.kind === "multi"
			? a.selected && a.selected.length > 0
				? a.selected.join(", ")
				: "(no input)"
			: a.kind === "custom"
				? a.answer && a.answer.length > 0
					? a.answer
					: "(no input)"
				: (a.answer ?? "(no input)");
	const parts: string[] = [`"${a.question}"="${scalar}"`];
	if (a.preview && a.preview.length > 0)
		parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function buildQuestionnaireResponse(
	result: QuestionnaireResult | null | undefined,
	params: QuestionParams,
) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0
				? { globalNote: result.globalNote }
				: {}),
		});
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (result.globalNote && result.globalNote.length > 0) {
		segments.push(`global note: ${result.globalNote}.`);
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result.answers,
			cancelled: true,
		});
	}
	return buildToolResult(
		`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`,
		result,
	);
}

// ── Pure validation (mirrors upstream guards) ─────────────────────────────

export const RESERVED_LABELS = ["Other", "Type something."] as const;

export function validate(typed: QuestionParams): string | null {
	if (typed.questions.length === 0) return "At least one question is required";
	if (typed.questions.length > MAX_QUESTIONS)
		return `At most ${MAX_QUESTIONS} questions are allowed`;
	const seenQuestions = new Set<string>();
	for (const q of typed.questions) {
		if (seenQuestions.has(q.question)) return "Question text must be unique";
		seenQuestions.add(q.question);
	}
	for (const q of typed.questions) {
		if (q.options.length < MIN_OPTIONS)
			return `Each question requires at least ${MIN_OPTIONS} options`;
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if ((RESERVED_LABELS as readonly string[]).includes(o.label))
				return `Option label is reserved (${RESERVED_LABELS.join(", ")})`;
			if (seenLabels.has(o.label))
				return "Option labels must be unique within a question";
			seenLabels.add(o.label);
		}
	}
	return null;
}
