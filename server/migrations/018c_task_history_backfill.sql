UPDATE task_instances i
   SET reconstructed_history = true
  FROM tasks t, families f
 WHERE t.id = i.task_id AND f.id = i.family_id
   AND NOT i.is_extra AND t.recurrence <> 'once' AND i.status IN ('pending', 'expired')
   AND (i.created_at AT TIME ZONE f.timezone)::date > i.due_date;
