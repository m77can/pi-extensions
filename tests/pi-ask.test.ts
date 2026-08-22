import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAnswerSegment,
	buildQuestionnaireResponse,
	validate,
} from "../extensions/pi-ask/contract.ts";

// ── fixture helpers ────────────────────────────────────────────────────────

function q(overrides: Record<string, unknown> = {}) {
	return {
		question: "Q?",
		header: "Header",
		options: [
			{ label: "A", description: "first" },
			{ label: "B", description: "second" },
		],
		...overrides,
	};
}

// ── validate ───────────────────────────────────────────────────────────────

test("validate: empty questions -> error", () => {
	assert.ok(validate({ questions: [] }) !== null);
});

test("validate: too many questions -> error", () => {
	const questions = Array.from({ length: 5 }, (_, i) =>
		q({ question: `Q${i}` }),
	);
	assert.ok(validate({ questions }) !== null);
});

test("validate: duplicate question text -> error", () => {
	assert.equal(
		validate({ questions: [q(), q()] }),
		"Question text must be unique",
	);
});

test("validate: single option -> error", () => {
	assert.ok(
		validate({
			questions: [q({ options: [{ label: "A", description: "only" }] })],
		}) !== null,
	);
});

test("validate: reserved option labels -> error", () => {
	for (const label of ["Other", "Type something."]) {
		assert.ok(
			validate({
				questions: [
					q({
						options: [
							{ label, description: "bad" },
							{ label: "B", description: "ok" },
						],
					}),
				],
			}) !== null,
			`label ${label} should be rejected`,
		);
	}
});

test("validate: duplicate option labels -> error", () => {
	assert.equal(
		validate({
			questions: [
				q({
					options: [
						{ label: "A", description: "one" },
						{ label: "A", description: "two" },
					],
				}),
			],
		}),
		"Option labels must be unique within a question",
	);
});

test("validate: fully valid input -> null", () => {
	assert.equal(
		validate({
			questions: [q(), q({ question: "Q2", multiSelect: true })],
		}),
		null,
	);
});

// ── buildAnswerSegment ─────────────────────────────────────────────────────

test("buildAnswerSegment: option kind renders quoted scalar", () => {
	assert.equal(
		buildAnswerSegment({
			questionIndex: 0,
			question: "Q",
			kind: "option",
			answer: "A",
		}),
		'"Q"="A".',
	);
});

test("buildAnswerSegment: custom empty answer -> (no input)", () => {
	assert.equal(
		buildAnswerSegment({
			questionIndex: 0,
			question: "Q",
			kind: "custom",
			answer: "",
		}),
		'"Q"="(no input)".',
	);
});

test("buildAnswerSegment: multi selected joins labels", () => {
	assert.equal(
		buildAnswerSegment({
			questionIndex: 0,
			question: "Q",
			kind: "multi",
			answer: null,
			selected: ["x", "y"],
		}),
		'"Q"="x, y".',
	);
});

test("buildAnswerSegment: preview and notes suffixes", () => {
	assert.equal(
		buildAnswerSegment({
			questionIndex: 0,
			question: "Q",
			kind: "option",
			answer: "A",
			preview: "P",
			notes: "N",
		}),
		'"Q"="A". selected preview: P. user notes: N.',
	);
});

// ── buildQuestionnaireResponse ─────────────────────────────────────────────

test("buildQuestionnaireResponse: null result -> decline envelope", () => {
	const r = buildQuestionnaireResponse(null, { questions: [q()] });
	assert.equal(r.content[0].text, "User declined to answer questions");
	assert.deepEqual(r.details.answers, []);
	assert.equal(r.details.cancelled, true);
});

test("buildQuestionnaireResponse: cancelled with globalNote preserves note", () => {
	const r = buildQuestionnaireResponse(
		{ answers: [], cancelled: true, globalNote: "still here" },
		{ questions: [q()] },
	);
	assert.equal(r.details.cancelled, true);
	assert.equal(r.details.globalNote, "still here");
});

test("buildQuestionnaireResponse: answered single question -> envelope", () => {
	const r = buildQuestionnaireResponse(
		{
			answers: [{ questionIndex: 0, question: "Q", kind: "option", answer: "A" }],
			cancelled: false,
		},
		{ questions: [q()] },
	);
	assert.equal(
		r.content[0].text,
		'User has answered your questions: "Q"="A". You can now continue with the user\'s answers in mind.',
	);
});

test("buildQuestionnaireResponse: multi-question follows params order", () => {
	const r = buildQuestionnaireResponse(
		{
			answers: [
				{ questionIndex: 1, question: "Q2", kind: "option", answer: "B" },
				{ questionIndex: 0, question: "Q1", kind: "option", answer: "A" },
			],
			cancelled: false,
		},
		{
			questions: [q({ question: "Q1" }), q({ question: "Q2" })],
		},
	);
	assert.equal(
		r.content[0].text,
		'User has answered your questions: "Q1"="A". "Q2"="B". You can now continue with the user\'s answers in mind.',
	);
});

test("buildQuestionnaireResponse: answer outside params range is skipped", () => {
	const r = buildQuestionnaireResponse(
		{
			answers: [{ questionIndex: 7, question: "Q", kind: "option", answer: "A" }],
			cancelled: false,
		},
		{ questions: [q()] },
	);
	// No segments matched → canonical decline fallback.
	assert.equal(r.content[0].text, "User declined to answer questions");
	assert.equal(r.details.cancelled, true);
});

test("buildQuestionnaireResponse: zero segments -> decline fallback", () => {
	const r = buildQuestionnaireResponse(
		{ answers: [], cancelled: false },
		{ questions: [q()] },
	);
	assert.equal(r.content[0].text, "User declined to answer questions");
	assert.equal(r.details.cancelled, true);
});
