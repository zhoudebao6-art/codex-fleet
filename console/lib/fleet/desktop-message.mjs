// Collector activities are stored oldest first. Their position is authoritative
// even when Codex does not supply an item timestamp, or several items share one.
// Do not use thread.preview: Codex defines it as the opening user message.
export function latestDesktopMessageSql(alias='t') {
  return `(SELECT json_object('text',substr(json_extract(a.value,'$.text'),1,1000),
    'role',CASE json_extract(a.value,'$.type') WHEN 'user_message' THEN 'user' ELSE 'assistant' END,
    'at',json_extract(a.value,'$.at'))
    FROM json_each(${alias}.details,'$.activities') a
    WHERE json_extract(a.value,'$.type') IN('user_message','assistant_message')
      AND length(trim(COALESCE(json_extract(a.value,'$.text'),'')))>0
    ORDER BY CAST(a.key AS INTEGER) DESC LIMIT 1)`;
}
