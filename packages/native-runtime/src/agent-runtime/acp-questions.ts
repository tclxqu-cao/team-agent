import type { AgentEvent } from "@agent/core";
import { acpRecords } from "./acp-session-projection.js";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { RuntimeSessionError, type RuntimeQuestionAnswer } from "./types.js";

type Question = Omit<Extract<AgentEvent, { type: "ask_user" }>, "type" | "questionId">;

export interface AcpQuestionCard {
  display: Question;
  answer(input: RuntimeQuestionAnswer): { value: unknown; text: string } | undefined;
}

interface AcpQuestionRequest {
  cards: AcpQuestionCard[];
  cancel: NativeJsonPacket;
  reply(answers: Array<unknown>): NativeJsonPacket;
}

function choices(value: unknown) {
  return acpRecords(value).flatMap(option => typeof option.label !== "string" ? [] : [{
    label: option.label,
    description: typeof option.description === "string" ? option.description : "",
    ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
  }]);
}

function selectedIndices(answer: RuntimeQuestionAnswer, count: number, multi: boolean): number[] {
  const indices = [...new Set(answer.selectedIndices ?? [])];
  if (indices.length > (multi ? count : 1) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new RuntimeSessionError("请选择有效选项", "QUESTION_ANSWER_FAILED");
  }
  return indices;
}

function grokQuestion(params: NativeJsonPacket): AcpQuestionRequest {
  const questions = acpRecords(params.questions).filter(row => typeof row.question === "string" && row.question.trim());
  const cards = questions.map<AcpQuestionCard>(item => {
    const options = choices(item.options);
    const multiSelect = item.multiSelect === true;
    return {
      display: { question: String(item.question), options, multiSelect },
      answer(input) {
        const indices = selectedIndices(input, options.length, multiSelect);
        const selected = indices.map(index => options[index]);
        const text = input.answer.trim();
        if (!selected.length && !text) throw new RuntimeSessionError("请输入回答", "QUESTION_ANSWER_FAILED");
        const labels = selected.length ? selected.map(option => option.label) : ["Other"];
        const preview = !multiSelect ? selected[0]?.preview : undefined;
        const notes = !selected.length ? text : undefined;
        return { text, value: { labels, annotation: preview || notes ? { preview, notes } : undefined } };
      },
    };
  });
  return {
    cards,
    cancel: { outcome: "cancelled" },
    reply(answers) {
      const labels = Object.fromEntries(questions.map((item, index) => [item.question, nativeRecord(answers[index]).labels]));
      const annotations = Object.fromEntries(questions.flatMap((item, index) => {
        const annotation = nativeRecord(answers[index]).annotation;
        return annotation ? [[item.question, annotation]] : [];
      }));
      return { outcome: "accepted", answers: labels, ...(Object.keys(annotations).length ? { annotations } : {}) };
    },
  };
}

function schemaChoice(value: unknown): { value: string; label: string; description: string }[] {
  const schema = nativeRecord(value);
  const labels: unknown[] = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  if (Array.isArray(schema.enum)) return schema.enum.flatMap((entry, index) => typeof entry === "string" ? [{
    value: entry, label: typeof labels[index] === "string" ? labels[index] : entry, description: "",
  }] : []);
  return acpRecords(schema.oneOf ?? schema.anyOf).flatMap(option => typeof option.const === "string" ? [{
    value: option.const, label: typeof option.title === "string" ? option.title : option.const,
    description: typeof option.description === "string" ? option.description : "",
  }] : []);
}

function elicitationField(name: string, field: NativeJsonPacket, message: string, required: boolean): AcpQuestionCard {
  const multiSelect = field.type === "array";
  const options = field.type === "boolean" ? [
    { label: "是", value: "true", description: "" }, { label: "否", value: "false", description: "" },
  ] : schemaChoice(multiSelect ? field.items : field);
  const title = typeof field.title === "string" ? field.title : name;
  const question = [message, title === message ? "" : title, typeof field.description === "string" ? field.description : ""].filter(Boolean).join("\n");
  const skipIndex = options.length;
  return {
    display: { question, options: [...options, ...(!required ? [{ label: "跳过", description: "不提交此字段" }] : [])],
      multiSelect, allowFreeText: !options.length },
    answer(input) {
      const indices = selectedIndices(input, options.length + Number(!required), multiSelect);
      if (!required && indices.includes(skipIndex)) {
        if (indices.length !== 1) throw new RuntimeSessionError("跳过时请取消其他选项", "QUESTION_ANSWER_FAILED");
        return undefined;
      }
      const text = input.answer.trim();
      if (options.length) {
        const selected = indices.length ? indices.map(index => options[index]?.value) : options.filter(option => option.value === text).map(option => option.value);
        if (!selected.length) throw new RuntimeSessionError("请选择一个可用选项", "QUESTION_ANSWER_FAILED");
        if (multiSelect) {
          checkRange(selected.length, field.minItems, field.maxItems);
          return { value: selected, text };
        }
        return { value: field.type === "boolean" ? selected[0] === "true" : selected[0], text };
      }
      if (!text) throw new RuntimeSessionError("请输入回答", "QUESTION_ANSWER_FAILED");
      if (field.type === "number" || field.type === "integer") {
        const n = Number(text);
        if (!Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n))) {
          throw new RuntimeSessionError("请输入符合要求的数字", "QUESTION_ANSWER_FAILED");
        }
        checkRange(n, field.minimum, field.maximum);
        return { value: n, text };
      }
      checkRange(text.length, field.minLength, field.maxLength);
      return { value: text, text };
    },
  };
}

function checkRange(value: number, minimum: unknown, maximum: unknown): void {
  if ((typeof minimum === "number" && value < minimum) || (typeof maximum === "number" && value > maximum)) {
    throw new RuntimeSessionError("回答超出允许范围", "QUESTION_ANSWER_FAILED");
  }
}

function agyQuestion(params: NativeJsonPacket): AcpQuestionRequest {
  const schema = nativeRecord(params.requestedSchema);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const message = typeof params.message === "string" ? params.message : "";
  const fields = Object.entries(nativeRecord(schema.properties)).flatMap(([name, value]) => {
    const field = nativeRecord(value);
    const valid = ["string", "number", "integer", "boolean", "array"].includes(String(field.type))
      && (field.type !== "array" || schemaChoice(field.items).length > 0);
    return valid ? [{ name, field }] : [];
  });
  const cancel = { action: "cancel" };
  if (params.mode !== "form" || schema.type !== "object" || [...required].some(name => !fields.some(field => field.name === name))) {
    return { cards: [], cancel, reply: () => cancel };
  }
  // Antigravity encodes the write-in for an option group as a sibling field.
  // Keep both choices on the same card and return the vendor's actual field name.
  const writeIns = new Map(fields.flatMap(({ name, field }) => {
    if (!name.endsWith("_other") || field.type !== "string" || required.has(name)) return [];
    const base = name.slice(0, -"_other".length);
    const source = fields.find(candidate => candidate.name === base);
    return source && !required.has(base) && schemaChoice(source.field).length ? [[base, { name, field }] as const] : [];
  }));
  const cards = fields.filter(({ name }) => ![...writeIns.values()].some(field => field.name === name));
  return {
    cards: cards.map(({ name, field }) => {
      const base = elicitationField(name, field, message, required.has(name));
      const writeIn = writeIns.get(name);
      return {
        display: { ...base.display, allowFreeText: Boolean(writeIn) || base.display.allowFreeText },
        answer(input) {
          if (writeIn && !input.selectedIndices?.length) {
            const text = input.answer.trim();
            if (!text) throw new RuntimeSessionError("请输入回答", "QUESTION_ANSWER_FAILED");
            checkRange(text.length, writeIn.field.minLength, writeIn.field.maxLength);
            return { value: [writeIn.name, text], text };
          }
          const result = base.answer(input);
          return result && { ...result, value: [name, result.value] };
        },
      };
    }),
    cancel,
    reply(answers) {
      return { action: "accept", content: Object.fromEntries(answers.flatMap(value =>
        Array.isArray(value) ? [value as [string, unknown]] : [])) };
    },
  };
}

export function readAcpQuestion(agent: "grok" | "agy", method: string, params: NativeJsonPacket): AcpQuestionRequest | undefined {
  if (agent === "grok" && method === "_x.ai/ask_user_question") return grokQuestion(params);
  if (agent === "agy" && method === "elicitation/create") return agyQuestion(params);
  return undefined;
}
