import {
	DynamicBorder,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type Component,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getConfig } from "../../shared/pi-tui-store.js";

/**
 * pi-ask — self-contained replacement for @juicesharp/rpiv-ask-user-question.
 *
 * Registers the `ask_user_question` tool with the SAME schema contract and
 * LLM-facing envelope as the upstream package, but renders the questionnaire
 * with pi-tui's own rounded frame (╭─╮ │ ╰─╯) instead of a borderless overlay.
 *
 * Deliberately kept dependency-free: no rpiv-i18n / rpiv-config imports.
 * UI chrome text is Chinese; the tool description (model-facing) is English.
 */

// ── Tool schema (model-facing contract, mirroring upstream) ────────────────

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;

const OptionSchema = Type.Object({
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

const QuestionSchema = Type.Object({
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

const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "Questions to ask the user (1-4 questions)",
});

const ParametersSchema = Type.Object({ questions: QuestionsSchema });

interface QuestionUi {
	customRow?: string;
	submit?: string;
	inputPrompt?: string;
	hint?: string;
}

interface QuestionParams {
	questions: {
		question: string;
		header: string;
		options: { label: string; description: string; preview?: string }[];
		multiSelect?: boolean;
		ui?: QuestionUi;
	}[];
}

interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	globalNote?: string;
}

// ── Tool definition (English, model-facing) ───────────────────────────────

const TOOL_DESCRIPTION =
	"Ask the user one or more structured questions when you need clarification or a decision before proceeding, instead of guessing. Each question shows 2-4 predefined options plus an automatically appended 'Type something.' row for custom answers. IMPORTANT: option labels must be concise (1-5 words); every option needs a description explaining the choice and its trade-offs; set multiSelect: true when multiple answers are valid; if you recommend one option, make it the first option. Do NOT author 'Other' or 'Type something.' options yourself — reserved labels are rejected at runtime. Pressing Esc abandons the questionnaire — treat the returned cancelled result as an explicit decline.";

const DECLINE_MESSAGE = "User declined to answer questions";
const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

function buildAnswerSegment(a: QuestionAnswer): string {
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

function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function buildQuestionnaireResponse(
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

const RESERVED_LABELS = ["Other", "Type something."] as const;

function validate(typed: QuestionParams): string | null {
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

// ── Questionnaire UI (rounded frame, pi-tui style) ────────────────────────

class AskUi {
	private readonly params: QuestionParams;
	private readonly theme: Theme;
	private readonly onDone: (result: QuestionnaireResult) => void;
	private tab = 0;
	private optionIndex = 0;
	private inputMode = false;
	private draft = "";
	private multiChecked = new Map<number, Set<string>>();
	private readonly answered = new Map<number, QuestionAnswer>();

	constructor(
		params: QuestionParams,
		theme: Theme,
		onDone: (result: QuestionnaireResult) => void,
	) {
		this.params = params;
		this.theme = theme;
		this.onDone = onDone;
	}

	private currentQuestion() {
		// SAFETY: tab is clamped against questions.length on every change; an
		// empty question list is rejected by validate() before any UI exists.
		const q = this.params.questions[this.tab];
		return q;
	}

	private rows(): { label: string; role: "option" | "custom" | "submit" }[] {
		const q = this.currentQuestion();
		const rows: { label: string; role: "option" | "custom" | "submit" }[] =
			q.options.map((o) => ({ label: o.label, role: "option" as const }));
		rows.push({ label: q.ui?.customRow ?? "Type something.", role: "custom" });
		if (q.multiSelect)
			rows.push({ label: q.ui?.submit ?? "[Done]", role: "submit" });
		return rows;
	}

	private rowsCount(): number {
		return this.rows().length;
	}

	private multiSet(): Set<string> {
		let s = this.multiChecked.get(this.tab);
		if (!s) {
			s = new Set();
			this.multiChecked.set(this.tab, s);
		}
		return s;
	}

	private static optionAnswer(
		kind: "option" | "multi",
		questionIndex: number,
		question: string,
		opt: { label: string; preview?: string } | undefined,
		selected?: string[],
	): QuestionAnswer {
		return kind === "option"
			? {
					questionIndex,
					question,
					kind,
					answer: opt?.label ?? null,
					preview: opt?.preview,
				}
			: { questionIndex, question, kind, answer: null, selected };
	}

	private finishQuestion(answer: QuestionAnswer) {
		this.answered.set(this.tab, answer);
		if (this.tab + 1 < this.params.questions.length) {
			this.tab++;
			this.optionIndex = 0;
			this.inputMode = false;
			this.draft = "";
		} else {
			const answers: QuestionAnswer[] = [];
			for (let i = 0; i < this.params.questions.length; i++) {
				const a = this.answered.get(i);
				if (a) answers.push(a);
			}
			this.onDone({ answers, cancelled: false });
		}
		this.invalidate();
	}

	private commitDraft() {
		const q = this.currentQuestion();
		const answer: QuestionAnswer = {
			questionIndex: this.tab,
			question: q.question,
			kind: "custom",
			answer: this.draft.trim() || null,
		};
		this.finishQuestion(answer);
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.commitDraft();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.draft = this.draft.slice(0, -1);
				this.invalidate();
				return;
			}
			// Printable characters only.
			if (data.length === 1 && data >= " ") {
				this.draft += data;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.onDone({
				answers: Array.from(this.answered.values()),
				cancelled: true,
			});
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = Math.min(this.rowsCount() - 1, this.optionIndex + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.tab = Math.min(this.params.questions.length - 1, this.tab + 1);
			this.optionIndex = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.tab = Math.max(0, this.tab - 1);
			this.optionIndex = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			if (this.inputMode) return;
			const q = this.currentQuestion();
			// SAFETY: optionIndex is clamped to rowsCount()-1 (see up/down);
			// rows() maps 1:1 to options for all indexes except the custom and
			// submit sentinels, which are handled below and never index options.
			const row = this.rows()[this.optionIndex] ?? { label: "", role: "option" };
			switch (row.role) {
				case "submit": {
					this.finishQuestion(
						AskUi.optionAnswer(
							"multi",
							this.tab,
							q.question,
							undefined,
							Array.from(this.multiSet()),
						),
					);
					return;
				}
				case "custom": {
					this.inputMode = true;
					this.invalidate();
					return;
				}
				default: {
					if (q.multiSelect) {
						const set = this.multiSet();
						if (set.has(row.label)) set.delete(row.label);
						else set.add(row.label);
						this.invalidate();
						return;
					}
					this.finishQuestion(
						AskUi.optionAnswer(
							"option",
							this.tab,
							q.question,
							q.options[this.optionIndex],
						),
					);
					return;
				}
			}
		}
	}

	// Content rows only — no frame/padding. The frame is drawn by
	// pi-chrome's Container.render patch around the DynamicBorder pair.
	render(width: number): string[] {
		const theme = this.theme;
		const paint = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);
		const bold = (s: string) => theme.bold(s);

		const innerWidth = Math.max(1, width - 2);
		const q = this.currentQuestion();
		const content: string[] = [];

		// Header row: [tab chip] question
		const tabChips = this.params.questions
			.map((_, i) =>
				i === this.tab
					? paint(bold(`[${i + 1}/${this.params.questions.length} ${q.header}]`))
					: dim(` ${i + 1} `),
			)
			.join(" ");
		content.push(tabChips);
		content.push(q.question);
		content.push(dim("─".repeat(innerWidth)));

		// Options
		const rows = this.rows();
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i]!;
			const isSel = i === this.optionIndex;
			let prefix: string;
			let label: string;
			if (isSel) {
				prefix = paint("▸ ");
				label = paint(bold(row.label));
			} else {
				prefix = "  ";
				label = row.label;
			}
			if (q.multiSelect && row.role === "option") {
				const checked = this.multiSet().has(row.label);
				label = `${checked ? paint("● ") : muted("○ ")}${label}`;
			}
			const opt = q.options[i];
			const desc = opt && !this.inputMode && isSel ? `  ${opt.description}` : "";
			content.push(`${prefix}${label}${desc}`);
		}

		// Input row (custom text)
		if (this.inputMode) {
			content.push(dim(`${q.ui?.inputPrompt ?? "Type: "}${this.draft}▌`));
		}

		// Preview panel for selected single-select option
		const selectedOpt = this.inputMode ? undefined : q.options[this.optionIndex];
		if (selectedOpt?.preview && !q.multiSelect && selectedOpt !== undefined) {
			content.push("");
			const wrapped = wrapTextWithAnsi(dim(selectedOpt.preview), innerWidth - 2);
			for (const wl of wrapped) {
				content.push(`  ${wl}`);
			}
		}

		// Hint（默认英文；模型可生成对应语言按键提示）
		content.push(
			dim(q.ui?.hint ?? "↑/↓ move · Enter/Space select · Tab switch · Esc cancel"),
		);

		// Frame owned by pi-chrome's patch: two DynamicBorder children pair
		// into ╭─╮ / ╰─╯ and content rows get │ rails automatically.
		const container = new Container();
		container.addChild(new DynamicBorder(paint));
		container.addChild(new LinesComponent(() => content));
		container.addChild(new DynamicBorder(paint));
		return container.render(width);
	}

	invalidate(): void {
		// Frame-less content is rebuilt on every render; nothing to cache.
	}
}

/** Thin Component adapter around pre-rendered rows. */
class LinesComponent implements Component {
	constructor(private readonly getLines: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.getLines(width);
	}
}

// ── Extension factory ──────────────────────────────────────────────────────

export default function piAsk(pi: ExtensionAPI): void {
	const c = getConfig();
	if (!c.enabled) return;

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Ask the user structured questions when a decision is needed",
		parameters: ParametersSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			// SAFETY: typebox validated rawParams against ParamsSchema, which is a
			// structural superset of QuestionParams (options[].preview optional).
			const typed = rawParams as unknown as QuestionParams;
			const error = validate(typed);
			if (error) {
				return buildToolResult(`Error: ${error}`, {
					answers: [],
					cancelled: true,
				});
			}
			if (!ctx.hasUI) {
				return buildToolResult(
					"Error: this client cannot render the questionnaire (custom UI unavailable). Ask the questions as plain chat text instead.",
					{ answers: [], cancelled: true },
				);
			}

			const result = await ctx.ui.custom<QuestionnaireResult | undefined>(
				(tui: TUI, theme, _kb, done) => {
					// done(result) closes the overlay AND resolves this await.
					const ui = new AskUi(typed, theme, (r) => done(r));
					return {
						render: (w: number) => ui.render(w),
						invalidate: () => ui.invalidate(),
						handleInput: (data: string) => {
							ui.handleInput(data);
							tui.requestRender();
						},
					};
				},
			);

			// Fallback: spacerless RPC hosts return undefined → simple prompt.
			if (result === undefined) {
				return buildToolResult(
					"Error: this client cannot render the questionnaire (custom UI unavailable). Ask the questions as plain chat text instead.",
					{ answers: [], cancelled: true },
				);
			}
			return buildQuestionnaireResponse(result, typed);
		},
	});
}
