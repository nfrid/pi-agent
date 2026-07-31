import {
  hasUnresolvedToolFailure as sharedHasUnresolvedToolFailure,
  validationKindsOf,
} from '../../extensions/activity-groups/outcome-core.mjs';

const TODO_CUSTOM_TYPES = new Set([
  'lean-todo',
  'lean-todo-turn-snapshot',
  'lean-todo-replay-v2',
  'lean-todo-replay',
]);

const TOOL_BASE = (name) =>
  String(name ?? '')
    .split('.')
    .at(-1) ?? '';
const MUTATION_TOOLS = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'str_replace',
  'delete',
  'mkdir',
  'move',
  'rename',
]);
const INSPECTION_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'glob',
  'web_search',
  'fetch_content',
  'get_search_content',
  'inspect_shell',
]);
const DELIVERY_TOOLS = new Set(['commit', 'merge', 'amend', 'push', 'rebase']);
const VALIDATION_KINDS = ['lint', 'test', 'typecheck', 'format', 'check'];
const PLAN_OUTCOMES = [
  'absent',
  'unavailable',
  'empty',
  'active-censored',
  'blocked-censored',
  'all-done',
  'dropped-only',
  'mixed-terminal',
  'superseded',
  'removed',
];
const SHAPES = [
  'analysis-only',
  'mutation-unvalidated',
  'mutation-validated',
  'operations',
  'other',
];
const LANGUAGES = ['english', 'russian', 'mixed', 'unknown'];
const DISPOSITIONS = [
  'accepted',
  'advance',
  'revise',
  'inquiry',
  'new-task',
  'unknown',
];

function timestampOf(entry) {
  const value = Date.parse(entry?.timestamp ?? entry?.message?.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function messageText(entry) {
  return contentText(entry?.message?.content ?? entry?.content);
}

function messageParts(entry) {
  return Array.isArray(entry?.message?.content) ? entry.message.content : [];
}

function objectArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function toolCalls(entry) {
  if (entry?.type !== 'message' || entry.message?.role !== 'assistant')
    return [];
  return messageParts(entry)
    .filter(
      (part) => part?.type === 'toolCall' && typeof part.name === 'string',
    )
    .map((part, partIndex) => ({
      ...part,
      args: objectArgs(part),
      id:
        typeof part.id === 'string'
          ? part.id
          : `episode-call-${entry.__episodeIndex}-${partIndex}`,
      entryIndex: entry.__episodeIndex,
      partIndex,
      timestamp: timestampOf(entry),
    }));
}

function compareCallOrder(left, right) {
  if (left.entryIndex !== right.entryIndex)
    return left.entryIndex - right.entryIndex;
  return (left.partIndex ?? 0) - (right.partIndex ?? 0);
}

function callAfter(left, right) {
  return compareCallOrder(left, right) > 0;
}

function successfulResult(result) {
  return Boolean(result) && result.message?.isError !== true;
}

function languageOf(text) {
  const normalized = String(text ?? '').normalize('NFKC');
  let latin = 0;
  let cyrillic = 0;
  for (const character of normalized) {
    if (/[A-Za-z]/.test(character)) latin += 1;
    else if (/[А-Яа-яЁё]/.test(character)) cyrillic += 1;
  }
  if (latin && cyrillic) return 'mixed';
  if (latin) return 'english';
  if (cyrillic) return 'russian';
  return 'unknown';
}

function normalizedDispositionText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/[“”«»„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQuestion(text) {
  if (/[?؟]/.test(text) && /\p{L}/u.test(text)) return true;
  return (
    /^(?:what|why|how|when|where|which|who|can|could|would|should|do|does|did|is|are|am|may|might)\b/.test(
      text,
    ) ||
    /^(?:что|как|когда|где|какой|какая|кто|можно|можешь|можете|нужно ли|стоит ли)(?:\s|$)/.test(
      text,
    )
  );
}

function isConditional(text) {
  return /\b(?:if|unless|whether|would|could|should|when)\b|(?:^|\s)(?:если|ли|когда бы|можно было бы)(?:\s|$)/.test(
    text,
  );
}

function hasNegation(text) {
  return (
    /\b(?:not|never|no|don't|doesn't|isn't|aren't|can't|cannot|won't|without)\b/.test(
      text,
    ) || /(?:^|\s)не\s+(?:одобр|принима|подход|год|работ|соглас)/.test(text)
  );
}

function hasRevisionCue(text) {
  return (
    /\b(?:still|yet|again|(?<!no )errors?|failed|failure|bug|broken|regression|wrong|correction|amend|amended|revert|rollback|retry|repair|doesn't work|not working|does not work|fails|failing)\b/.test(
      text,
    ) ||
    /(?:все еще|все еше|по-прежнему|ошибк\w*|не работает|слом\w*|исправ\w*|почин\w*|поправ\w*|передел\w*|откат\w*|регресс\w*)/.test(
      text,
    )
  );
}

function hasExplicitCorrection(text) {
  return (
    /\b(?:please\s+)?(?:fix|repair|amend|revert|rollback|retry)\s+(?:it|this|that|the\s+(?:result|change|changes|implementation|code|error|errors|bug|issue))\b/.test(
      text,
    ) ||
    /\b(?:please\s+)?correct\s+(?:it|this|that|the\s+(?:result|change|changes|implementation|code|error|errors|bug|issue))\b/.test(
      text,
    ) ||
    /\b(?:исправь|исправить|почини|починить|поправь|переделай|откати|повтори)\b/.test(
      text,
    )
  );
}

function hasPositiveVerificationCue(text) {
  return (
    /\b(?:the\s+result\s+is\s+correct|no\s+errors?(?:\s+now)?|looks\s+good)\b/.test(
      text,
    ) ||
    /\b(?:(?:the|this|that|your|a)\s+)?(?:fix|solution|change|implementation|code)\s+(?:is\s+(?:correct|right|working|successful)|works?(?:\s+(?:correctly|well|as\s+expected))?|worked(?:\s+as\s+expected)?)\b/.test(
      text,
    )
  );
}

function hasDisagreementCue(text) {
  return (
    /\b(?:reject|rejects|rejected|disagree|disagrees|disagreed|disagreement|object)\b/.test(
      text,
    ) || /(?:^|\s)не\s+(?:одобр|принима|соглас)/.test(text)
  );
}

function hasExplicitApprovalNegation(text) {
  return (
    /\b(?:do not|don't|cannot|can't|never)\s+(?:approve|accept|agree)\b/.test(
      text,
    ) || /(?:^|\s)не\s+(?:одобр|принима|соглас)/.test(text)
  );
}

function hasAcceptanceCue(text) {
  return (
    /^(?:(?:yes|okay|ok|all good|good to go|looks good|that works|works|perfect|great|excellent|nice|approved|approve|accepted|accept|agree|lgtm|ship it|well done|thank you|thanks)(?:[.!,:;]?\s|$))/.test(
      text,
    ) ||
    /^(?:да|хорошо|все хорошо|подходит|годится|годно|одобр\p{L}*|принима\p{L}*|принят\p{L}*|соглас\p{L}*|отличн\p{L}*|супер)(?:[.!,:;]?\s|$)/u.test(
      text,
    ) ||
    /\b(?:i\s+)?(?:approve|accept|agree)\s+(?:this|it|that|the result|the change|the changes)\b/.test(
      text,
    )
  );
}

function hasAdvanceCue(text) {
  return (
    /^(?:please\s+)?(?:implement|continue|proceed|go ahead|move on|start|begin|run(?: the)? tests?|test|check|commit|amend|merge|push|ship|apply|carry on|do it|finish)\b/.test(
      text,
    ) ||
    /\b(?:commit and push|merge and push|implement (?:it|this)|proceed with|go ahead with)\b/.test(
      text,
    ) ||
    /^(?:приступ\p{L}*|продолж\p{L}*|начин\p{L}*|переход\p{L}*|делай\p{L}*|сделай\p{L}*|реализ\p{L}*|тестир\p{L}*|проверь\p{L}*|коммить\p{L}*|закоммить\p{L}*|пуш\p{L}*|запуш\p{L}*|слей\p{L}*|вливай\p{L}*|двигайся дальше)(?:[.!,:;]?(?:\s|$))/u.test(
      text,
    ) ||
    /\b(?:коммить и пушь|закоммить и запушь|приступай к)\b/.test(text)
  );
}

function hasNewTaskCue(text) {
  return /\b(?:new task|different task|separate task|another task|unrelated|новая задача|другая задача|отдельная задача|другая работа)\b/.test(
    text,
  );
}

// An advance cue only overrides a question when it occupies its own
// sentence/clause. Commas are intentionally not boundaries because they can
// join an ambiguous question and instruction.
function hasSeparateImperativeAdvance(text) {
  const clauses = text.split(/(?<=[.!?؟;])\s+|\n+/);
  if (clauses.length < 2) return false;
  return clauses.some((clause) => {
    const candidate = clause.trim();
    return (
      !isQuestion(candidate) &&
      !isConditional(candidate) &&
      !hasNegation(candidate) &&
      hasAdvanceCue(candidate)
    );
  });
}

/**
 * Classify only the immediate user reaction. The rules intentionally require
 * phrase shape instead of treating a word such as "good" or "approve" as a
 * disposition on its own. This is local, deterministic, and content is never
 * returned to callers.
 */
export function classifyDispositionDetail(input) {
  const text = normalizedDispositionText(input);
  const language = languageOf(input);
  if (!text) return { disposition: 'unknown', language };

  const question = isQuestion(text);
  const conditional = isConditional(text);
  const explicitCorrection = hasExplicitCorrection(text);
  const positiveVerification = hasPositiveVerificationCue(text);
  const revision = explicitCorrection || hasRevisionCue(text);
  // A confirmed correction remains a correction even when it is phrased as a
  // request. Conditional future failures are not confirmed failures.
  if (
    revision &&
    (!question || explicitCorrection) &&
    (!conditional || /\b(?:still|yet)\b|не работает|ошибк/.test(text))
  )
    return { disposition: 'revise', language };

  const negated = hasNegation(text);
  const explicitApprovalNegation = hasExplicitApprovalNegation(text);
  const disagreement = hasDisagreementCue(text);
  if (
    !question &&
    !conditional &&
    !explicitApprovalNegation &&
    !disagreement &&
    (!negated || positiveVerification) &&
    (hasAcceptanceCue(text) || positiveVerification)
  )
    return { disposition: 'accepted', language };
  if (!question && !conditional && !negated && hasAdvanceCue(text))
    return { disposition: 'advance', language };
  if (question && hasSeparateImperativeAdvance(text))
    return { disposition: 'advance', language };
  if (question) return { disposition: 'inquiry', language };
  if (hasNewTaskCue(text)) return { disposition: 'new-task', language };
  return { disposition: 'unknown', language };
}

export function classifyDisposition(input) {
  return classifyDispositionDetail(input).disposition;
}

function stateFromValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  const candidate =
    value.state && typeof value.state === 'object' ? value.state : value;
  if (!Array.isArray(candidate.tasks)) return undefined;
  const tasks = new Map();
  for (const task of candidate.tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string')
      continue;
    const status = ['todo', 'doing', 'blocked', 'done', 'dropped'].includes(
      task.status,
    )
      ? task.status
      : 'todo';
    tasks.set(task.id, status);
  }
  const details = new Map(
    candidate.tasks
      .filter(
        (task) =>
          task && typeof task === 'object' && typeof task.id === 'string',
      )
      .map((task) => [
        task.id,
        JSON.stringify({
          text: task.text,
          notes: task.notes,
          dependsOn: task.dependsOn ?? task.depends_on,
          priority: task.priority,
        }),
      ]),
  );
  return { tasks, details, available: true };
}

function stateFromCustomEntry(entry) {
  if (!TODO_CUSTOM_TYPES.has(entry?.customType)) return undefined;
  const candidates = [entry?.data, entry?.data?.state, entry?.content];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const state = stateFromValue(candidate);
      if (state) return state;
    }
    if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        const state = stateFromValue(parsed);
        if (state) return state;
      } catch {
        // Legacy replay content is intentionally treated as unavailable; it
        // may contain task text but cannot safely be emitted or reconstructed.
      }
    }
  }
  return undefined;
}

function cloneState(state) {
  return {
    tasks: new Map(state.tasks),
    details: new Map(state.details ?? []),
    available: state.available,
  };
}

function taskSignature(state) {
  return [...state.tasks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, status]) => `${id}:${status}:${state.details?.get(id) ?? ''}`)
    .join('|');
}

function hasUnfinished(state) {
  return [...state.tasks.values()].some((status) =>
    ['todo', 'doing', 'blocked'].includes(status),
  );
}

function hasBlocked(state) {
  return [...state.tasks.values()].some((status) => status === 'blocked');
}

function terminalOutcome(state, reason) {
  if (reason === 'remove') return 'removed';
  if (state.tasks.size === 0) return 'empty';
  const statuses = [...state.tasks.values()];
  if (statuses.every((status) => status === 'done')) return 'all-done';
  if (statuses.every((status) => status === 'dropped')) return 'dropped-only';
  if (statuses.every((status) => ['done', 'dropped'].includes(status)))
    return 'mixed-terminal';
  return undefined;
}

function normalizeTaskId(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function applyTodoAction(state, action, args, nextId) {
  const next = cloneState(state);
  const id = normalizeTaskId(args.id, `episode-task-${nextId.value++}`);
  if (action === 'list') return next;
  if (
    !state.available &&
    [
      'update',
      'start',
      'done',
      'block',
      'drop',
      'remove',
      'clear_done',
    ].includes(action)
  )
    return next;
  next.available = true;
  if (action === 'add') {
    next.tasks.set(
      id,
      ['todo', 'doing', 'blocked', 'done', 'dropped'].includes(args.status)
        ? args.status
        : 'todo',
    );
    next.details.set(
      id,
      JSON.stringify({
        text: args.text,
        notes: args.notes,
        dependsOn: args.depends_on,
        priority: args.priority,
      }),
    );
    return next;
  }
  if (action === 'replace') {
    next.tasks = new Map();
    next.details = new Map();
    for (const task of Array.isArray(args.tasks) ? args.tasks : []) {
      if (!task || typeof task !== 'object') continue;
      const taskId = normalizeTaskId(task.id, `episode-task-${nextId.value++}`);
      next.tasks.set(
        taskId,
        ['todo', 'doing', 'blocked', 'done', 'dropped'].includes(task.status)
          ? task.status
          : 'todo',
      );
      next.details.set(
        taskId,
        JSON.stringify({
          text: task.text,
          notes: task.notes,
          dependsOn: task.depends_on,
          priority: task.priority,
        }),
      );
    }
    return next;
  }
  if (action === 'clear_done') {
    for (const [taskId, status] of next.tasks)
      if (status === 'done' || status === 'dropped') {
        next.tasks.delete(taskId);
        next.details.delete(taskId);
      }
    return next;
  }
  if (action === 'remove') {
    next.tasks.delete(id);
    next.details.delete(id);
    return next;
  }
  if (['start', 'done', 'block', 'drop'].includes(action)) {
    const status = {
      start: 'doing',
      done: 'done',
      block: 'blocked',
      drop: 'dropped',
    }[action];
    if (next.tasks.has(id)) next.tasks.set(id, status);
    return next;
  }
  if (action === 'update' && next.tasks.has(id)) {
    if (['todo', 'doing', 'blocked', 'done', 'dropped'].includes(args.status))
      next.tasks.set(id, args.status);
    next.details.set(
      id,
      JSON.stringify({
        text: args.text,
        notes: args.notes,
        dependsOn: args.depends_on,
        priority: args.priority,
      }),
    );
  }
  return next;
}

function todoOperations(call, result) {
  if (!successfulResult(result)) return [];
  const args = call.args;
  if (args.action === 'batch')
    return Array.isArray(args.operations)
      ? args.operations.filter(
          (operation) => operation && typeof operation === 'object',
        )
      : [];
  return typeof args.action === 'string' ? [args] : [];
}

function priorUserIndex(entries, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1)
    if (
      entries[cursor]?.type === 'message' &&
      entries[cursor].message?.role === 'user'
    )
      return cursor;
  return index;
}

function nextUserIndex(entries, index) {
  for (let cursor = index + 1; cursor < entries.length; cursor += 1)
    if (
      entries[cursor]?.type === 'message' &&
      entries[cursor].message?.role === 'user'
    )
      return cursor;
  return entries.length;
}

function makeTodoEpoch(start, state, reason, startCall) {
  return {
    start,
    end: undefined,
    plan: undefined,
    state: cloneState(state),
    startCall,
    endCall: undefined,
    endCallExclusive: false,
    closeIndex: undefined,
    closeReason: reason,
  };
}

function deriveTodo(entries, callResults) {
  const state = { tasks: new Map(), available: false };
  const nextId = { value: 1 };
  const epochs = [];
  let current;
  let todoSeen = false;
  let parsedStateSeen = false;
  let explicitEmpty = false;
  let planHint;
  let epochCount = 0;

  const close = (index, outcome, reason, call, endCallExclusive = false) => {
    if (!current) return;
    current.closeIndex = index;
    current.plan = outcome;
    current.closeReason = reason;
    current.end = index;
    current.endCall = call;
    current.endCallExclusive = endCallExclusive;
    epochs.push(current);
    current = undefined;
  };

  const observe = (next, index, reason, action, call) => {
    const beforeActive = hasUnfinished(state);
    const afterActive = hasUnfinished(next);
    const changed = taskSignature(state) !== taskSignature(next);
    Object.assign(state, next);
    if (next.available) parsedStateSeen = true;
    if (next.tasks.size === 0) explicitEmpty = true;
    if (!changed && !action && !beforeActive && !afterActive) return;

    if (current && action === 'replace' && beforeActive && changed) {
      // The replacement call belongs to the new plan. The old epoch ends
      // immediately before it, even when both calls share one assistant entry.
      close(index, 'superseded', reason, call, true);
    } else if (current && beforeActive && !afterActive) {
      close(index, terminalOutcome(next, action ?? reason), reason, call);
    }
    if (!current && afterActive) {
      current = makeTodoEpoch(
        priorUserIndex(entries, index),
        next,
        reason,
        epochCount > 0 ? call : undefined,
      );
      epochCount += 1;
    }
    if (!current && !afterActive && next.available) {
      planHint = terminalOutcome(next, action ?? reason) ?? planHint;
    }
  };

  for (const entry of entries) {
    const index = entry.__episodeIndex;
    const snapshot = stateFromCustomEntry(entry);
    if (snapshot) {
      todoSeen = true;
      observe(snapshot, index, 'snapshot');
    } else if (TODO_CUSTOM_TYPES.has(entry?.customType)) {
      todoSeen = true;
    }
    for (const call of toolCalls(entry)) {
      if (TOOL_BASE(call.name) !== 'todo') continue;
      todoSeen = true;
      const result = callResults.get(call.id);
      for (const operation of todoOperations(call, result)) {
        const action = operation.action;
        if (
          ![
            'list',
            'add',
            'update',
            'start',
            'done',
            'block',
            'drop',
            'remove',
            'clear_done',
            'replace',
          ].includes(action)
        ) {
          continue;
        }
        const next = applyTodoAction(state, action, operation, nextId);
        observe(next, index, action, action, call);
      }
    }
  }

  if (current) {
    current.end = entries.length - 1;
    current.plan = hasBlocked(state) ? 'blocked-censored' : 'active-censored';
    current.state = cloneState(state);
    epochs.push(current);
  }

  let availability = 'absent';
  if (todoSeen) availability = parsedStateSeen ? 'empty' : 'unavailable';
  if (explicitEmpty && parsedStateSeen && !epochs.length)
    availability = 'empty';
  if (planHint && !epochs.length) availability = planHint;
  return { epochs, todoSeen, availability };
}

function commandArg(call) {
  const args = call?.args ?? {};
  return typeof args.command === 'string' ? args.command : '';
}

function commandHead(command) {
  const heredoc = command.search(/<<-?\s*['"]?[A-Za-z_]\w*['"]?/);
  const source = heredoc >= 0 ? command.slice(0, heredoc) : command;
  return source.replace(/\s+/g, ' ').trim();
}

function isMutationCommand(command) {
  const head = commandHead(command).toLowerCase();
  return (
    /(?:^|[;&|]\s*)(?:sed|perl|python|python3|ruby|node)\b[^\n]*(?:-i|write|rename|unlink|remove)/.test(
      head,
    ) ||
    /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|chmod|git\s+(?:apply|checkout|restore|reset))\b/.test(
      head,
    ) ||
    /(?:>|>>|tee\s+)/.test(head)
  );
}

function validationKinds(call) {
  return validationKindsOf(call.name, call.args);
}

const hasUnresolvedToolFailure = sharedHasUnresolvedToolFailure;

function isDeliveryCall(call) {
  const name = TOOL_BASE(call.name);
  if (DELIVERY_TOOLS.has(name)) return name;
  if (name !== 'bash') return undefined;
  const command = commandHead(commandArg(call)).toLowerCase();
  if (/(?:^|[;&|]\s*)git\s+commit\b/.test(command))
    return command.includes('--amend') ? 'amend' : 'commit';
  if (/(?:^|[;&|]\s*)git\s+(?:merge|rebase)\b/.test(command)) return 'merge';
  if (/(?:^|[;&|]\s*)git\s+push\b/.test(command)) return 'push';
  return undefined;
}

function makeValidationFacet(calls, results, mutationCalls) {
  const attempts = Object.fromEntries(
    VALIDATION_KINDS.map((kind) => [kind, 0]),
  );
  const successes = Object.fromEntries(
    VALIDATION_KINDS.map((kind) => [kind, 0]),
  );
  const failures = Object.fromEntries(
    VALIDATION_KINDS.map((kind) => [kind, 0]),
  );
  const successfulTimes = [];
  const failedAttempts = [];
  for (const call of calls) {
    const kinds = validationKinds(call);
    if (!kinds.length) continue;
    const result = results.get(call.id);
    const success = successfulResult(result);
    for (const kind of kinds) {
      attempts[kind] += 1;
      if (success) successes[kind] += 1;
      else failures[kind] += 1;
    }
    if (success) successfulTimes.push({ time: call.timestamp, kinds, call });
    else failedAttempts.push({ time: call.timestamp, kinds, call });
  }
  const retryCount = Object.fromEntries(
    VALIDATION_KINDS.map((kind) => [kind, 0]),
  );
  for (const failed of failedAttempts) {
    // A multi-kind command contributes an independent retry for each kind.
    // Do not let a successful test clear a failed lint in the same command.
    for (const kind of failed.kinds) {
      const later = calls.find(
        (candidate) =>
          callAfter(candidate, failed.call) &&
          validationKinds(candidate).includes(kind) &&
          successfulResult(results.get(candidate.id)),
      );
      if (later) retryCount[kind] += 1;
    }
  }
  const unresolvedFailure = failedAttempts.some((failed) =>
    failed.kinds.some(
      (kind) =>
        !calls.some(
          (candidate) =>
            callAfter(candidate, failed.call) &&
            validationKinds(candidate).includes(kind) &&
            successfulResult(results.get(candidate.id)),
        ),
    ),
  );
  const lastSuccessful = successfulTimes.at(-1);
  const lastMutation = mutationCalls.at(-1);
  const hasAttempts = Object.values(attempts).some((value) => value > 0);
  const hasSuccess = successfulTimes.length > 0;
  let status = 'not observed';
  if (hasAttempts && (unresolvedFailure || !hasSuccess)) status = 'failed';
  else if (
    hasSuccess &&
    lastMutation &&
    !callAfter(lastSuccessful.call, lastMutation)
  )
    status = 'stale-after-later-mutation';
  else if (hasSuccess) status = 'passed';
  const aggregateToExplicitCorrection =
    failedAttempts.some((failed) => failed.kinds.includes('check')) &&
    failedAttempts.some(
      (failed) =>
        failed.kinds.includes('check') &&
        successfulTimes.some(
          (success) =>
            callAfter(success.call, failed.call) &&
            success.kinds.some((kind) => kind !== 'check'),
        ),
    );
  return {
    status,
    attempts,
    successes,
    failures,
    retries: retryCount,
    aggregateToExplicitCorrection,
    successfulTimes,
    lastSuccessfulTime: lastSuccessful?.time,
  };
}

function shapeOf(
  calls,
  validation,
  mutationCount,
  deliveryAttempts,
  delegateCount,
) {
  const names = calls.map((call) => TOOL_BASE(call.name));
  if (mutationCount > 0)
    return validation.status === 'passed'
      ? 'mutation-validated'
      : 'mutation-unvalidated';
  if (
    deliveryAttempts > 0 ||
    delegateCount > 0 ||
    names.some((name) => ['process', 'background_process'].includes(name))
  )
    return 'operations';
  if (calls.length > 0 && names.every((name) => INSPECTION_TOOLS.has(name)))
    return 'analysis-only';
  return 'other';
}

function durationFrom(start, time) {
  return time === undefined || start === undefined
    ? undefined
    : Math.max(0, time - start);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function makeBucket(records, dimension, value) {
  const episodes = records.length;
  const count = (predicate) => records.filter(predicate).length;
  const operationalSettled = count(
    (record) => record.operational === 'inferred-settled',
  );
  const planKnown = count(
    (record) => !['absent', 'unavailable'].includes(record.plan),
  );
  const reactionObserved = count((record) => record.reactionObserved);
  const validationObserved = count(
    (record) => record.validation.status !== 'not observed',
  );
  const settled = operationalSettled;
  const duration = (field) =>
    median(
      records
        .map((record) => record[field])
        .filter((value) => typeof value === 'number'),
    );
  const planCounts = Object.fromEntries(
    PLAN_OUTCOMES.map((outcome) => [
      outcome,
      count((record) => record.plan === outcome),
    ]),
  );
  const dispositionCounts = Object.fromEntries(
    DISPOSITIONS.map((disposition) => [
      disposition,
      count((record) => record.disposition === disposition),
    ]),
  );
  return {
    ...(dimension ? { [dimension]: value } : {}),
    sample: episodes,
    episodeCount: episodes,
    operationalSettled: operationalSettled,
    operationalSettledRate: episodes ? operationalSettled / episodes : 0,
    operationalFailed: count((record) => record.operational === 'failed'),
    operationalAborted: count((record) => record.operational === 'aborted'),
    operationalTimedOut: count((record) => record.operational === 'timed-out'),
    operationalCensored: count((record) => record.operational === 'censored'),
    unresolvedToolFailure: count(
      (record) => record.operational === 'unresolved-tool-failure',
    ),
    planCounts,
    allPlanDone: planCounts['all-done'],
    allPlanDoneDenominator: planKnown,
    missingPlan: planCounts.absent,
    unavailablePlan: planCounts.unavailable,
    unknownPlan: planCounts.unavailable,
    allPlanDoneRate: planKnown ? planCounts['all-done'] / planKnown : 0,
    observedVerification: count((record) => record.observedVerification),
    observedVerificationDenominator: settled,
    observedVerificationRate: settled
      ? count((record) => record.observedVerification) / settled
      : 0,
    dispositionCounts,
    explicitAcceptance: dispositionCounts.accepted,
    explicitAcceptanceRate: reactionObserved
      ? dispositionCounts.accepted / reactionObserved
      : 0,
    advancement: dispositionCounts.advance,
    advancementRate: reactionObserved
      ? dispositionCounts.advance / reactionObserved
      : 0,
    revisionReopen: dispositionCounts.revise,
    revisionReopenRate: reactionObserved
      ? dispositionCounts.revise / reactionObserved
      : 0,
    falseDoneProxy: count(
      (record) => record.plan === 'all-done' && record.disposition === 'revise',
    ),
    falseDoneProxyRate: planCounts['all-done']
      ? count(
          (record) =>
            record.plan === 'all-done' && record.disposition === 'revise',
        ) / planCounts['all-done']
      : 0,
    validationAttempts: records.reduce(
      (sum, record) =>
        sum +
        Object.values(record.validation.attempts).reduce(
          (inner, value) => inner + value,
          0,
        ),
      0,
    ),
    validationRetries: records.reduce(
      (sum, record) =>
        sum +
        Object.values(record.validation.retries).reduce(
          (inner, value) => inner + value,
          0,
        ),
      0,
    ),
    validationNotObserved: episodes - validationObserved,
    staleValidation: count(
      (record) => record.validation.status === 'stale-after-later-mutation',
    ),
    staleValidationRate: validationObserved
      ? count(
          (record) => record.validation.status === 'stale-after-later-mutation',
        ) / validationObserved
      : 0,
    blockedPlans: planCounts['blocked-censored'],
    droppedPlans: planCounts['dropped-only'] + planCounts['mixed-terminal'],
    noTodoPlans: planCounts.absent,
    unknownDisposition: count(
      (record) => record.reactionObserved && record.disposition === 'unknown',
    ),
    unknownDispositionDenominator: reactionObserved,
    missingDisposition: episodes - reactionObserved,
    unknownLanguage: count((record) => record.language === 'unknown'),
    missingLanguage: count(
      (record) => record.language === 'unknown' && !record.reactionObserved,
    ),
    recoveryFailures: records.reduce(
      (sum, record) => sum + record.recovery.delegateProviderFailures,
      0,
    ),
    recoveryTurns: records.reduce(
      (sum, record) => sum + record.recovery.parentTurnsAfterFailure,
      0,
    ),
    recoveryToolCalls: records.reduce(
      (sum, record) => sum + record.recovery.parentToolCallsAfterFailure,
      0,
    ),
    durations: {
      firstMutationMs: duration('firstMutationMs'),
      planClosureMs: duration('planClosureMs'),
      successfulValidationMs: duration('successfulValidationMs'),
      userAcceptanceOrAdvancementMs: median(
        records
          .map((record) =>
            record.disposition === 'accepted' ||
            record.disposition === 'advance'
              ? record.userDispositionMs
              : undefined,
          )
          .filter((value) => typeof value === 'number'),
      ),
      phaseApprovalImplementationValidationCommitMs: median(
        records
          .map((record) => record.phaseDurationMs)
          .filter((value) => typeof value === 'number'),
      ),
    },
  };
}

function buildCohorts(records) {
  const byShape = Object.fromEntries(
    SHAPES.map((shape) => [
      shape,
      makeBucket(
        records.filter((record) => record.shape === shape),
        'shape',
        shape,
      ),
    ]),
  );
  const byLanguage = Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      makeBucket(
        records.filter((record) => record.language === language),
        'language',
        language,
      ),
    ]),
  );
  return { all: makeBucket(records), byShape, byLanguage };
}

export function aggregateEpisodeCohorts(records) {
  return buildCohorts(Array.isArray(records) ? records : []);
}

function deliveryFacet(calls, results) {
  const facet = {
    commitAttempts: 0,
    commitSuccesses: 0,
    commitFailures: 0,
    amendAttempts: 0,
    amendSuccesses: 0,
    amendFailures: 0,
    mergeAttempts: 0,
    mergeSuccesses: 0,
    mergeFailures: 0,
    pushAttempts: 0,
    pushSuccesses: 0,
    pushFailures: 0,
    lastSuccessTime: undefined,
  };
  for (const call of calls) {
    const kind = isDeliveryCall(call);
    if (!kind) continue;
    const success = successfulResult(results.get(call.id));
    facet[`${kind}Attempts`] += 1;
    facet[`${kind}${success ? 'Successes' : 'Failures'}`] += 1;
    if (success) facet.lastSuccessTime = call.timestamp;
    // A git --amend is also a commit attempt, but its separate amend counters
    // make the delivery facet useful without exposing the command.
    if (kind === 'amend') {
      facet.commitAttempts += 1;
      facet[`${success ? 'commitSuccesses' : 'commitFailures'}`] += 1;
    }
  }
  return facet;
}

function delegateFacet(entries, calls, results) {
  const failures = [];
  const seen = new Set();
  for (const call of calls) {
    if (TOOL_BASE(call.name) !== 'delegate') continue;
    const result = results.get(call.id);
    const runs = Array.isArray(result?.message?.details?.runs)
      ? result.message.details.runs
      : [];
    if (result?.message?.isError === true && runs.length === 0) {
      failures.push({ index: call.entryIndex, id: call.id });
      continue;
    }
    const runFailure = runs.some(
      (run) =>
        run?.state === 'error' ||
        run?.stopReason === 'error' ||
        (typeof run?.exitCode === 'number' && run.exitCode > 0) ||
        run?.state === 'timed-out' ||
        run?.state === 'aborted',
    );
    if (result?.message?.isError === true && !runFailure)
      failures.push({ index: call.entryIndex, id: call.id });
    runs.forEach((run, runIndex) => {
      const id =
        typeof run?.backgroundJobId === 'string'
          ? run.backgroundJobId
          : `${call.id}:${runIndex}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (
        run?.state === 'error' ||
        run?.stopReason === 'error' ||
        (typeof run?.exitCode === 'number' && run.exitCode > 0) ||
        run?.state === 'timed-out' ||
        run?.state === 'aborted'
      )
        failures.push({ index: call.entryIndex, id, run });
    });
  }
  for (const entry of entries) {
    if (entry.customType !== 'delegate-job-result') continue;
    const jobs = Array.isArray(entry.details?.jobs)
      ? entry.details.jobs
      : entry.details?.job
        ? [entry.details.job]
        : [];
    for (const job of jobs) {
      const id =
        typeof job?.id === 'string' ? job.id : `job-${entry.__episodeIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (job?.state === 'error' || job?.error)
        failures.push({ index: entry.__episodeIndex, id, job });
    }
  }
  return { failures, seen };
}

function toolItems(calls, results) {
  return calls.map((call) => ({
    type: 'tool',
    id: call.id,
    name: call.name,
    args: call.args,
    status: results.has(call.id) ? 'complete' : 'running',
    isError: Boolean(results.get(call.id)?.message?.isError),
  }));
}

function deriveEpisodeRecord(entries, epoch, context) {
  const start = epoch.start;
  const end = Math.max(
    start,
    Math.min(epoch.end ?? entries.length - 1, entries.length - 1),
  );
  const scopedEntries = entries.slice(start, end + 1);
  const calls = context.calls.filter((call) => {
    if (call.entryIndex < start || call.entryIndex > end) return false;
    if (epoch.startCall && compareCallOrder(call, epoch.startCall) < 0)
      return false;
    if (epoch.endCall) {
      const comparison = compareCallOrder(call, epoch.endCall);
      if (comparison > 0) return false;
      if (epoch.endCallExclusive && comparison === 0) return false;
    }
    return true;
  });
  const results = new Map(
    calls
      .map((call) => [call.id, context.results.get(call.id)])
      .filter(([, result]) => result),
  );
  const mutations = calls.filter(
    (call) =>
      MUTATION_TOOLS.has(TOOL_BASE(call.name)) ||
      (TOOL_BASE(call.name) === 'bash' && isMutationCommand(commandArg(call))),
  );
  const successfulMutations = mutations.filter((call) =>
    successfulResult(results.get(call.id)),
  );
  const mutationTimes = successfulMutations
    .map((call) => call.timestamp)
    .filter((time) => time !== undefined);
  const validation = makeValidationFacet(calls, results, successfulMutations);
  const delivery = deliveryFacet(calls, results);
  const delegate = delegateFacet(scopedEntries, calls, results);
  const items = toolItems(calls, results);
  // A delegate/provider failure is a recovery facet, not an unresolved parent
  // tool intent: direct parent work can settle the same episode without
  // pretending the failed child succeeded.
  const unresolved = hasUnresolvedToolFailure(
    items.filter((item) => TOOL_BASE(item.name) !== 'delegate'),
  );
  const runStates = calls.flatMap((call) => {
    const result = results.get(call.id);
    return Array.isArray(result?.message?.details?.runs)
      ? result.message.details.runs
      : [];
  });
  const timedOut = runStates.some(
    (run) => run?.state === 'timed-out' || run?.exitCode === 124,
  );
  const aborted = runStates.some(
    (run) => run?.state === 'aborted' || run?.stopReason === 'aborted',
  );
  const assistants = scopedEntries.filter(
    (entry) => entry.type === 'message' && entry.message?.role === 'assistant',
  );
  const lastAssistant = assistants.at(-1);
  const lastAssistantCalls = lastAssistant
    ? toolCalls(lastAssistant).length
    : 0;
  const lastMeaningfulEntry = scopedEntries
    .filter(
      (entry) =>
        entry.type === 'message' || entry.customType === 'delegate-job-result',
    )
    .at(-1);
  const terminalResponse = Boolean(
    lastAssistant &&
      lastMeaningfulEntry &&
      lastAssistant.__episodeIndex === lastMeaningfulEntry.__episodeIndex &&
      lastAssistantCalls === 0,
  );
  const firstFailure = delegate.failures.at(0);
  const firstFailureCall = firstFailure
    ? calls.find((call) => call.id === firstFailure.id)
    : undefined;
  const parentEntries = firstFailure
    ? scopedEntries.filter(
        (entry) =>
          entry.__episodeIndex > firstFailure.index &&
          entry.type === 'message' &&
          entry.message?.role === 'assistant',
      )
    : [];
  const parentToolCalls = firstFailure
    ? calls.filter((call) =>
        firstFailureCall
          ? callAfter(call, firstFailureCall)
          : call.entryIndex > firstFailure.index,
      ).length
    : 0;
  // A timed-out child remains visible in recovery failures, but successful
  // parent work and a terminal response settle the episode operationally.
  const successfulParentToolCalls = firstFailure
    ? calls.filter((call) => {
        if (
          TOOL_BASE(call.name) === 'delegate' ||
          TOOL_BASE(call.name) === 'todo'
        )
          return false;
        if (
          firstFailureCall
            ? !callAfter(call, firstFailureCall)
            : call.entryIndex <= firstFailure.index
        )
          return false;
        return successfulResult(results.get(call.id));
      })
    : [];
  const recoveredAfterDelegateFailure = Boolean(
    firstFailure &&
      terminalResponse &&
      successfulParentToolCalls.length > 0 &&
      !unresolved,
  );
  const operational = recoveredAfterDelegateFailure
    ? 'inferred-settled'
    : timedOut
      ? 'timed-out'
      : aborted
        ? 'aborted'
        : unresolved
          ? 'unresolved-tool-failure'
          : terminalResponse
            ? 'inferred-settled'
            : delegate.failures.length
              ? 'failed'
              : 'censored';
  const firstTime = timestampOf(entries[start]);
  const successfulValidation = validation.successfulTimes.at(-1);
  const successfulValidationTime = successfulValidation?.time;
  const lastMutationCall = successfulMutations.at(-1);
  const finalMutationValidated = Boolean(
    lastMutationCall &&
      successfulValidation?.call &&
      callAfter(successfulValidation.call, lastMutationCall),
  );
  const observedVerification =
    operational === 'inferred-settled' &&
    lastMutationCall !== undefined &&
    validation.successfulTimes.some((item) =>
      callAfter(item.call, lastMutationCall),
    );
  const shape = shapeOf(
    calls,
    validation,
    successfulMutations.length,
    delivery.commitAttempts + delivery.mergeAttempts + delivery.pushAttempts,
    calls.filter((call) => TOOL_BASE(call.name) === 'delegate').length,
  );
  const recovery = {
    delegateProviderFailures: delegate.failures.length,
    parentTurnsAfterFailure: parentEntries.length,
    parentToolCallsAfterFailure: parentToolCalls,
    reachedSettled: Boolean(firstFailure && operational === 'inferred-settled'),
    reachedObservedVerification: Boolean(firstFailure && observedVerification),
  };
  const reaction = context.users.find((user) => user.index > end);
  const reactionDetail = reaction
    ? classifyDispositionDetail(reaction.text)
    : { disposition: 'unknown', language: 'unknown' };
  const intervalHasTodo =
    calls.some((call) => TOOL_BASE(call.name) === 'todo') ||
    scopedEntries.some((entry) => TODO_CUSTOM_TYPES.has(entry.customType));
  const plan =
    epoch.kind === 'fallback' && !intervalHasTodo
      ? 'absent'
      : (epoch.plan ??
        (intervalHasTodo
          ? context.todo.availability === 'empty'
            ? 'empty'
            : context.todo.availability
          : 'absent'));
  const disposition = reactionDetail.disposition;
  const userDispositionMs = reaction
    ? durationFrom(firstTime, reaction.time)
    : undefined;
  const phaseDurationMs =
    successfulMutations.length > 0 &&
    successfulValidation?.call &&
    delivery.lastSuccessTime !== undefined &&
    callAfter(successfulValidation.call, successfulMutations[0]) &&
    delivery.lastSuccessTime >= successfulValidationTime
      ? durationFrom(firstTime, delivery.lastSuccessTime)
      : undefined;
  return {
    start,
    end,
    plan: PLAN_OUTCOMES.includes(plan) ? plan : 'unavailable',
    operational,
    shape,
    language: reaction ? reactionDetail.language : 'unknown',
    disposition,
    reactionObserved: Boolean(reaction),
    observedVerification,
    falseDoneProxy: plan === 'all-done' && disposition === 'revise',
    validation: {
      status: validation.status,
      attempts: validation.attempts,
      successes: validation.successes,
      failures: validation.failures,
      retries: validation.retries,
      aggregateToExplicitCorrection: validation.aggregateToExplicitCorrection,
    },
    delivery: {
      commitAttempts: delivery.commitAttempts,
      commitSuccesses: delivery.commitSuccesses,
      commitFailures: delivery.commitFailures,
      amendAttempts: delivery.amendAttempts,
      amendSuccesses: delivery.amendSuccesses,
      amendFailures: delivery.amendFailures,
      mergeAttempts: delivery.mergeAttempts,
      mergeSuccesses: delivery.mergeSuccesses,
      mergeFailures: delivery.mergeFailures,
      pushAttempts: delivery.pushAttempts,
      pushSuccesses: delivery.pushSuccesses,
      pushFailures: delivery.pushFailures,
    },
    mutation: {
      attempts: mutations.length,
      successful: successfulMutations.length,
      firstSuccessful: successfulMutations.length > 0,
      laterMutationsFollowedValidation: successfulMutations.some((call) =>
        validation.successfulTimes.some((validationCall) =>
          callAfter(call, validationCall.call),
        ),
      ),
      finalMutationValidated,
    },
    recovery,
    midRunUserTurns: context.users.filter(
      (user) => user.index > start && user.index <= end,
    ).length,
    firstMutationMs: durationFrom(firstTime, mutationTimes[0]),
    planClosureMs:
      epoch.plan && epoch.closeIndex !== undefined
        ? durationFrom(firstTime, timestampOf(entries[epoch.closeIndex]))
        : undefined,
    successfulValidationMs: durationFrom(firstTime, successfulValidationTime),
    userDispositionMs,
    phaseDurationMs,
    _firstTime: firstTime,
    _mutationTimes: mutationTimes,
    _successfulValidationTime: successfulValidationTime,
  };
}

function hasWork(entries, start, end) {
  for (let index = start; index <= end; index += 1) {
    const entry = entries[index];
    if (
      entry?.type === 'message' &&
      ['assistant', 'toolResult'].includes(entry.message?.role)
    )
      return true;
    if (entry?.customType === 'delegate-job-result') return true;
  }
  return false;
}

function prepareIntervals(entries, todo) {
  const intervals = todo.epochs.map((epoch) => ({
    ...epoch,
    start: epoch.start,
    end: epoch.end ?? entries.length - 1,
    kind: 'todo',
  }));
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    const nextEpoch = intervals[index + 1];
    const nextUser = nextUserIndex(entries, interval.end);
    const maxEnd =
      nextEpoch && nextEpoch.start > interval.start
        ? Math.min(nextEpoch.start - 1, nextUser - 1)
        : nextUser - 1;
    if (nextUser < entries.length)
      interval.end = Math.max(interval.start, maxEnd);
    else interval.end = entries.length - 1;
  }
  return intervals;
}

function deriveFallbackIntervals(entries, todoIntervals, todo) {
  const intervals = [];
  const users = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => entry.type === 'message' && entry.message?.role === 'user',
    )
    .map(({ entry, index }) => ({
      index,
      text: messageText(entry),
      time: timestampOf(entry),
    }));
  const covered = (index) =>
    todoIntervals.some(
      (interval) => index >= interval.start && index <= interval.end,
    );
  for (const user of users) {
    if (covered(user.index)) continue;
    const nextUser = nextUserIndex(entries, user.index);
    const end = nextUser - 1;
    if (end < user.index || !hasWork(entries, user.index + 1, end)) continue;
    if (
      todoIntervals.some(
        (interval) => interval.start > user.index && interval.start <= end,
      )
    )
      continue;
    intervals.push({
      start: user.index,
      end,
      plan: todo.todoSeen ? todo.availability : 'absent',
      kind: 'fallback',
    });
  }
  return intervals;
}

function buildContext(entries) {
  const calls = [];
  const results = new Map();
  const users = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    entry.__episodeIndex = index;
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user')
      users.push({ index, text: messageText(entry), time: timestampOf(entry) });
    if (
      entry.message?.role === 'toolResult' &&
      typeof entry.message.toolCallId === 'string'
    )
      results.set(entry.message.toolCallId, entry);
    calls.push(...toolCalls(entry));
  }
  return { calls, results, users };
}

function stripInternal(record) {
  const clean = JSON.parse(
    JSON.stringify(record, (_key, value) =>
      value === undefined ? null : value,
    ),
  );
  delete clean._firstTime;
  delete clean._mutationTimes;
  delete clean._successfulValidationTime;
  delete clean.start;
  delete clean.end;
  if (clean.language === 'unknown' && clean.reactionObserved === false)
    clean.language = 'unknown';
  return clean;
}

/**
 * Derive episodes from an already selected active ancestry. The input entries
 * are mutated only with a non-enumerable private index used during parsing;
 * callers receive bounded records and no transcript material.
 */
export function deriveEpisodes(entries) {
  const active = entries.map((entry) => ({ ...entry }));
  const context = buildContext(active);
  const todo = deriveTodo(active, context.results);
  context.todo = todo;
  context.initialUser = context.users[0];
  const todoIntervals = prepareIntervals(active, todo);
  const fallbackIntervals = deriveFallbackIntervals(
    active,
    todoIntervals,
    todo,
  );
  const intervals = [...todoIntervals, ...fallbackIntervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const records = intervals.map((interval) =>
    deriveEpisodeRecord(active, interval, context),
  );

  // Link only the exact immediate next user turn. Do not search forward for a
  // later approving message: inquiry and unknown turns intentionally terminate
  // attribution.
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    record.phase =
      previous?.linkedPhase && intervals[index].start > intervals[index - 1].end
        ? 'linked'
        : 'initial';
    const nextUser = context.users.find(
      (user) => user.index > intervals[index].end,
    );
    if (nextUser) {
      const detail = classifyDispositionDetail(nextUser.text);
      record.disposition = detail.disposition;
      record.language = detail.language;
      record.reactionObserved = true;
      record.userDispositionMs = durationFrom(record._firstTime, nextUser.time);
      if (detail.disposition === 'advance' || detail.disposition === 'revise')
        record.linkedPhase = detail.disposition;
    } else {
      record.disposition = 'unknown';
      record.language = 'unknown';
      record.reactionObserved = false;
      record.userDispositionMs = null;
    }
  }

  const safe = records
    .map(stripInternal)
    .map((record, ordinal) => ({ ordinal: ordinal + 1, ...record }));
  return safe;
}

export function deriveEpisodeSummary(entries) {
  const records = deriveEpisodes(entries);
  return { records, cohorts: aggregateEpisodeCohorts(records) };
}

export {
  DISPOSITIONS,
  hasUnresolvedToolFailure,
  LANGUAGES,
  PLAN_OUTCOMES,
  SHAPES,
};
