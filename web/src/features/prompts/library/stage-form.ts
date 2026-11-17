import { z } from "zod";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { stageMessages as text } from "./stage-messages";

export const stageReasonSchema = (prefixes: readonly string[]) =>
  z
    .string()
    .trim()
    .min(1, text.reasonRequired)
    .refine(
      (value) =>
        [...value].length <= 500 &&
        !Array.from(value).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) &&
        !containsPotentialSecret(value, prefixes),
      text.reasonUnsafe,
    );
