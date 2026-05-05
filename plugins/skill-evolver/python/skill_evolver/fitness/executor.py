"""Execution fitness for the body target — LLM-as-judge against a rubric.

Given a skill body, have a model follow it against a task and score the
output on correctness, procedure-following, and conciseness. The textual
feedback is the raw material GEPA uses to propose mutations.
"""
from __future__ import annotations

from dataclasses import dataclass

import dspy


@dataclass
class TaskExample:
    prompt: str
    expected_behavior: str


@dataclass
class ExecutorScore:
    correctness: float
    procedure_following: float
    conciseness: float
    length_penalty: float
    feedback: str
    count: int

    @property
    def composite(self) -> float:
        weighted = (
            0.5 * self.correctness
            + 0.3 * self.procedure_following
            + 0.2 * self.conciseness
        )
        return max(0.0, weighted - self.length_penalty)


class FollowSkillSignature(dspy.Signature):
    """Follow the given skill instructions to respond to the user's task.

    Read the skill instructions carefully and apply them. Produce the
    output the skill asks for — no meta-commentary, no "here's what I did",
    just the artifact the skill is supposed to produce.
    """
    skill_instructions: str = dspy.InputField(desc="The full SKILL.md body (instructions)")
    user_task: str = dspy.InputField(desc="The task the user has given")
    response: str = dspy.OutputField(desc="The artifact/response produced by following the skill")


class JudgeSignature(dspy.Signature):
    """Score an agent response against an expected-behavior rubric.

    Score three dimensions from 0.0 to 1.0. Be strict — 1.0 means perfect,
    0.5 means clearly lacking, 0.0 means wrong or absent. Provide specific,
    actionable feedback a maintainer could act on.
    """
    task: str = dspy.InputField()
    expected_behavior: str = dspy.InputField(desc="Rubric describing a good response")
    skill_instructions: str = dspy.InputField()
    response: str = dspy.InputField()
    correctness: float = dspy.OutputField(desc="0.0-1.0: did the response correctly address the task?")
    procedure_following: float = dspy.OutputField(desc="0.0-1.0: did it follow the skill's procedure?")
    conciseness: float = dspy.OutputField(desc="0.0-1.0: appropriately concise without omitting essentials?")
    feedback: str = dspy.OutputField(
        desc="Specific, actionable feedback on what could be improved in the skill instructions"
    )


def _clamp(value: object) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v != v:  # NaN
        return 0.0
    return max(0.0, min(1.0, v))


def _length_penalty(body: str, max_bytes: int) -> float:
    size = len(body.encode("utf-8"))
    if size <= max_bytes:
        return 0.0
    overflow = size - max_bytes
    return min(0.5, overflow / max(1, max_bytes))


def score_body(
    *,
    body: str,
    tasks: list[TaskExample],
    eval_lm_name: str,
    max_body_bytes: int,
) -> ExecutorScore:
    if not tasks:
        return ExecutorScore(
            correctness=0.0,
            procedure_following=0.0,
            conciseness=0.0,
            length_penalty=0.0,
            feedback="No task examples provided — cannot score body.",
            count=0,
        )
    follower = dspy.Predict(FollowSkillSignature)
    judge = dspy.ChainOfThought(JudgeSignature)
    lm = dspy.LM(eval_lm_name)

    c_total = p_total = q_total = 0.0
    feedback_chunks: list[str] = []

    with dspy.context(lm=lm):
        for example in tasks:
            try:
                follow = follower(skill_instructions=body, user_task=example.prompt)
                response = str(getattr(follow, "response", ""))
            except Exception as err:  # pragma: no cover
                response = f"(follower error: {err})"
            try:
                verdict = judge(
                    task=example.prompt,
                    expected_behavior=example.expected_behavior,
                    skill_instructions=body,
                    response=response,
                )
                c = _clamp(getattr(verdict, "correctness", 0.0))
                p = _clamp(getattr(verdict, "procedure_following", 0.0))
                q = _clamp(getattr(verdict, "conciseness", 0.0))
                fb = str(getattr(verdict, "feedback", ""))[:400]
            except Exception as err:  # pragma: no cover
                c = p = q = 0.0
                fb = f"(judge error: {err})"
            c_total += c
            p_total += p
            q_total += q
            if c < 0.75 or p < 0.75:
                feedback_chunks.append(
                    f"- task={example.prompt!r}: c={c:.2f} p={p:.2f} q={q:.2f} — {fb}"
                )

    n = len(tasks)
    penalty = _length_penalty(body, max_body_bytes)
    feedback = "\n".join(
        [
            f"Average: correctness={c_total / n:.3f}, procedure={p_total / n:.3f}, conciseness={q_total / n:.3f}, penalty={penalty:.3f}",
            *feedback_chunks[:10],
        ]
    )
    if len(feedback_chunks) > 10:
        feedback += f"\n... and {len(feedback_chunks) - 10} more."

    return ExecutorScore(
        correctness=c_total / n,
        procedure_following=p_total / n,
        conciseness=q_total / n,
        length_penalty=penalty,
        feedback=feedback,
        count=n,
    )
