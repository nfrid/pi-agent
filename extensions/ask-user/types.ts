import type { Choice } from "./schema";

export type UiChoice = Required<Pick<Choice, "label" | "value">> & {
	description?: string;
	preview?: string;
	custom?: boolean;
};

export type Answer = {
	question: string;
	answer: string | null;
	choiceLabel?: string;
	choiceIndex?: number;
	custom: boolean;
	cancelled: boolean;
};

export type UiResult = {
	answer: string;
	choiceLabel?: string;
	choiceIndex?: number;
	custom: boolean;
} | null;
