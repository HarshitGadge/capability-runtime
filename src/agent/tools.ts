import type Anthropic from '@anthropic-ai/sdk';

/**
 * The agent's action surface.
 *
 * Deliberately small and semantic. The model refers to controls by the reference
 * numbers in the rendered screen, never by selector, never by coordinate — so its
 * choices are expressed in the same vocabulary the artifact will store, and there is
 * no way for it to invent a locator that was never verified against a real element.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'observe',
    description: 'Re-read the current screen. Every other tool already returns the updated screen, so call this only when you need to look again without acting.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'navigate',
    description: 'Load a URL. Must stay inside the allowlisted origin.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, why: { type: 'string', description: 'One clause: why this navigation is needed.' } },
      required: ['url', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click a control by its [ref] number from the current screen.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, why: { type: 'string', description: 'Intent, phrased as a reusable step description, e.g. "Submit the member search".' } },
      required: ['ref', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Type into a textbox by [ref]. Clears the field first.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' } },
      required: ['ref', 'text', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a dropdown by [ref], by its visible option text.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' }, why: { type: 'string' } },
      required: ['ref', 'value', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key, e.g. Enter or Escape.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, why: { type: 'string' } },
      required: ['key', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'start_recording',
    description:
      'Switch from exploring to recording. Call this once you know the exact path to the goal. The session is reset to the entry point and everything you do from here is captured as the reusable capability, so perform the flow cleanly with no detours. Declare the capability contract here: the inputs a caller must supply and the outputs they get back.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable slug, e.g. member.read_savings_balance' },
        name: { type: 'string' },
        description: { type: 'string', description: 'What a calling agent needs to know to decide whether to invoke this.' },
        inputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'currency', 'date'] },
              description: { type: 'string' },
              example: { type: 'string', description: 'The exact value you will use during this recording. Required — it is how typed values get parameterized.' },
              pattern: { type: 'string', description: 'Optional regular expression the value must match.' },
              sensitivity: { type: 'string', enum: ['public', 'internal', 'regulated', 'secret'] },
            },
            required: ['name', 'type', 'description', 'example'], additionalProperties: false,
          },
        },
        outputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'currency', 'date'] },
              description: { type: 'string' },
              sensitivity: { type: 'string', enum: ['public', 'internal', 'regulated', 'secret'] },
            },
            required: ['name', 'type', 'description'], additionalProperties: false,
          },
        },
      },
      required: ['id', 'name', 'description', 'inputs', 'outputs'], additionalProperties: false,
    },
  },
  {
    name: 'extract_output',
    description: 'Record that a declared output is read from this element. Only valid while recording. The value itself may be redacted on your screen — that is expected; you are pointing at where it lives, not reading it.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        output_name: { type: 'string' },
        transform: { type: 'string', enum: ['none', 'trim', 'currency_to_number', 'digits_only'] },
        why: { type: 'string' },
      },
      required: ['ref', 'output_name', 'why'], additionalProperties: false,
    },
  },
  {
    name: 'declare_outcome',
    description:
      'Declare a legitimate non-success result this capability can return, e.g. the member does not exist. Give the exact on-screen text that identifies it. Discover these by trying an invalid input during the exploring phase.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND' },
        description: { type: 'string' },
        when_text_present: { type: 'string', description: 'Exact distinctive text shown on that screen.' },
      },
      required: ['code', 'description', 'when_text_present'], additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'The goal is reached and the flow is fully recorded. Give the on-screen text that proves success.',
    input_schema: {
      type: 'object',
      properties: {
        success_text: { type: 'string', description: 'Distinctive text visible only on the success screen.' },
        summary: { type: 'string' },
      },
      required: ['success_text', 'summary'], additionalProperties: false,
    },
  },
];

export const SYSTEM_PROMPT = `You drive a legacy member-services web portal for a credit union, on behalf of an operator. You work through an accessibility view of the screen: a list of controls with reference numbers, plus the visible text. You never see markup and never write selectors.

You work in two phases.

PHASE 1 — EXPLORE. Find the path to the goal. Click around, go back, try things. Nothing here is recorded. Two things are worth doing before you finish exploring:
  - Confirm you can actually reach the goal screen.
  - Try one obviously invalid input (a member ID that will not exist) so you learn what the failure screen says, then call declare_outcome with its exact text. A capability that cannot tell "no such member" from "something broke" is not much use to a caller.

PHASE 2 — RECORD. Call start_recording, declaring the capability's inputs and outputs. The session resets to the entry point. Now perform the flow once, cleanly and minimally — every action is captured as a step in a reusable artifact that will be replayed thousands of times without you. No detours, no double-backs, no exploratory clicks.

Then call finish.

Rules:
- Refer to controls only by their [ref] number on the current screen. Refs change every time the screen changes; always use the numbers from the most recent screen.
- Some values appear as tokens like «currency:a1b2» or «account:9f33». That is regulated member data that has been redacted before reaching you. This is normal. You do not need the value — to capture it, point extract_output at the control holding it and the runtime reads the real value.
- Write every "why" as a reusable step description ("Submit the member search"), not a narration of this run ("click search for 12345"). These become the artifact's step intents and a human will review them.
- In start_recording, each input's "example" must be exactly the value you will type during recording. That is how a literal becomes a parameter.
- Prefer the path a trained operator would take. Do not try to be clever with URLs if the UI has a link.
- If you are stuck for more than a few attempts, call finish with what you have rather than thrashing.`;
