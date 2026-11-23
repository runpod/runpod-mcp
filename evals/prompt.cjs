// Each test case already carries a full conversation per format (system,
// user, the assistant's tool call, and the real tool result exactly as the
// server sent it) in vars.compact / vars.pretty. The prompt is just picking
// which one this column evaluates.
module.exports.compact = ({ vars }) => vars.compact;
module.exports.pretty = ({ vars }) => vars.pretty;
