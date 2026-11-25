// Pi uses the protocol's user role for both summarization jobs and their output.
export function isPiSummarization(text) {
  return (/^\s*# Conversation\r?\n/.test(text)
    && /^# Instructions\r?\nThe messages above are earlier context from an ongoing conversation\./m.test(text))
    || (/^\s*<conversation>\r?\n/.test(text)
    && /^<\/conversation>\r?\n(?:[\s\S]*\r?\n)?The messages above are (?:a conversation to summarize|NEW conversation messages to incorporate)/m.test(text));
}

export function isPiCompactionSummary(text) {
  return /^The conversation history before this point was compacted into the following summary:\r?\n\r?\n<summary>\r?\n[\s\S]*\r?\n<\/summary>\s*$/.test(text);
}
