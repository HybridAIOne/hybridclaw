/**
 * One argument-cardinality rule for initial prompts and runtime checkpoints.
 * This is model guidance, not a tool schema validator or authorization rule.
 */
export const TOOL_ARGUMENT_CARDINALITY =
  'Respect documented argument cardinality: a single-target field takes one ID or address. Do not pack several recipients into an address-valued string unless the endpoint documents that separator syntax; otherwise use separate calls for each recipient. Every call must include its required target and other required fields; parallel calls do not inherit arguments from each other. Combine targets only through documented list or batch inputs. A string-typed target does not imply support for comma-separated lists.';
