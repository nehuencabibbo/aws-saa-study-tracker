const STORAGE_KEY = "awsSaaTrackerState";
const COURSE_DATA_PATH = "assets/course-data.json";
const DEFAULT_PLAN_DAYS = 90;
const MAX_PLAN_DAYS = 3650;
const STATE_VERSION = 3;
const LOG_PREFIX = "[AWS SAA Tracker service worker]";
let initializationPromise;
let stateMutationQueue = Promise.resolve();

function enqueueStateMutation(operation) {
  const result = stateMutationQueue.then(operation, operation);
  stateMutationQueue = result.catch(() => {});
  return result;
}

console.info(`${LOG_PREFIX} Iniciado.`, { time: new Date().toISOString() });

function flattenCatalog(catalog) {
  return catalog.sections.flatMap((section) =>
    section.lessons.map((lesson) => ({
      ...lesson,
      sectionTitle: section.title,
    })),
  );
}

function remainingSeconds(lectures) {
  return Object.values(lectures).reduce((total, lecture) => {
    if (lecture.completed || lecture.durationSeconds == null) return total;
    return total + lecture.durationSeconds;
  }, 0);
}

function makeInitialState(catalog) {
  const lectures = Object.fromEntries(
    flattenCatalog(catalog).map((lecture) => [
      lecture.id,
      {
        ...lecture,
        completedAt: null,
      },
    ]),
  );

  const startDate = localDateKey();
  return {
    version: STATE_VERSION,
    courseId: catalog.id,
    title: catalog.title,
    lectures,
    plan: {
      mode: "duration",
      startDate,
      endDate: addDaysToDateKey(startDate, DEFAULT_PLAN_DAYS - 1),
      durationDays: DEFAULT_PLAN_DAYS,
      createdAt: new Date().toISOString(),
    },
    lastSyncAt: null,
    lastSnapshotAt: 0,
  };
}

function normalizeState(state) {
  const plan = state.plan || {};
  if (
    state.version >= STATE_VERSION &&
    ["duration", "date"].includes(plan.mode) &&
    isDateKey(plan.startDate) &&
    isDateKey(plan.endDate) &&
    Number.isInteger(plan.durationDays) &&
    Number.isFinite(state.lastSnapshotAt)
  ) return state;

  const startDate = isDateKey(plan.startDate) ? plan.startDate : localDateKey();
  const durationDays = clampPlanDays(plan.durationDays ?? plan.days ?? DEFAULT_PLAN_DAYS);
  const requestedEndDate = plan.endDate;
  const requestedMode = plan.mode === "date" && isDateKey(requestedEndDate) ? "date" : "duration";
  const dateModeDays = requestedMode === "date" ? daysBetweenDateKeys(startDate, requestedEndDate) + 1 : 0;
  const useDateMode = requestedMode === "date" && dateModeDays >= 1 && dateModeDays <= MAX_PLAN_DAYS;
  const normalizedPlan = useDateMode
    ? { mode: "date", startDate, endDate: requestedEndDate, durationDays: dateModeDays }
    : {
      mode: "duration",
      startDate,
      endDate: addDaysToDateKey(startDate, durationDays - 1),
      durationDays,
    };

  return {
    ...state,
    version: STATE_VERSION,
    plan: {
      ...normalizedPlan,
      createdAt: plan.createdAt || new Date().toISOString(),
    },
    lastSnapshotAt: Number.isFinite(state.lastSnapshotAt) ? state.lastSnapshotAt : 0,
  };
}

async function ensureState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    const state = normalizeState(stored[STORAGE_KEY]);
    if (state !== stored[STORAGE_KEY]) await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return state;
  }

  if (!initializationPromise) {
    initializationPromise = (async () => {
      const latest = await chrome.storage.local.get(STORAGE_KEY);
      if (latest[STORAGE_KEY]) {
        const state = normalizeState(latest[STORAGE_KEY]);
        if (state !== latest[STORAGE_KEY]) await chrome.storage.local.set({ [STORAGE_KEY]: state });
        return state;
      }
      const response = await fetch(chrome.runtime.getURL(COURSE_DATA_PATH));
      if (!response.ok) throw new Error("No se pudo cargar el catálogo inicial del curso.");
      const catalog = await response.json();
      const state = makeInitialState(catalog);
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      return state;
    })();
  }

  try {
    return await initializationPromise;
  } finally {
    initializationPromise = undefined;
  }
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenDateKeys(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

function clampPlanDays(value) {
  return Math.max(1, Math.min(MAX_PLAN_DAYS, Math.floor(Number(value) || DEFAULT_PLAN_DAYS)));
}

function planWindow(plan, today = localDateKey()) {
  if (!isDateKey(plan?.startDate) || !isDateKey(plan?.endDate)) {
    return { phase: "active", daysRemaining: clampPlanDays(plan?.days ?? DEFAULT_PLAN_DAYS) };
  }
  if (today < plan.startDate) {
    return {
      phase: "upcoming",
      daysRemaining: daysBetweenDateKeys(plan.startDate, plan.endDate) + 1,
    };
  }
  if (today > plan.endDate) return { phase: "overdue", daysRemaining: 0 };
  return {
    phase: "active",
    daysRemaining: daysBetweenDateKeys(today, plan.endDate) + 1,
  };
}

function todaySeconds(state, dateKey = localDateKey()) {
  return Object.values(state.lectures).reduce((total, lecture) => {
    if (!lecture.completedAt || localDateKey(new Date(lecture.completedAt)) !== dateKey) return total;
    return total + (lecture.durationSeconds || 0);
  }, 0);
}

function targetSeconds(state, dateKey = localDateKey()) {
  const window = planWindow(state.plan, dateKey);
  if (window.phase === "overdue" || window.daysRemaining < 1) return 0;
  const remaining = remainingSeconds(state.lectures);
  if (remaining <= 0) return 0;
  const completedToday = window.phase === "active" ? todaySeconds(state, dateKey) : 0;
  return (remaining + completedToday) / window.daysRemaining;
}

function compactDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${minutes} min`;
  return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
}

function updateActionBadge(state) {
  const window = planWindow(state.plan);
  const remaining = remainingSeconds(state.lectures);
  if (window.phase === "upcoming") {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: `AWS SAA Study Tracker · El plan empieza el ${state.plan.startDate}` });
    return;
  }
  if (window.phase === "overdue" && remaining > 0) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#9c3a35" });
    chrome.action.setTitle({ title: `AWS SAA Study Tracker · Fecha objetivo vencida · ${compactDuration(remaining)} pendientes` });
    return;
  }
  if (remaining <= 0) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#2f6851" });
    chrome.action.setTitle({ title: "AWS SAA Study Tracker · Curso completo · 100% del video" });
    return;
  }
  const completed = todaySeconds(state);
  const target = targetSeconds(state);
  const percent = target > 0 ? Math.min(100, Math.floor((completed / target) * 100)) : 100;
  const goalReached = completed >= target;

  // Chrome controls the badge typography and overlays it on the icon. Keep
  // only the numeric percentage here so 100% renders as three glyphs, not four.
  chrome.action.setBadgeText({ text: String(percent) });
  chrome.action.setBadgeBackgroundColor({ color: goalReached ? "#2f6851" : "#3f6d8c" });
  chrome.action.setTitle({
    title: `AWS SAA Study Tracker · Badge: ${percent}% de la meta diaria · Hoy: ${compactDuration(completed)} de ${compactDuration(target)}`,
  });
}

async function syncSnapshot(snapshot, tabId) {
  const state = await ensureState();
  const receivedAt = Number(snapshot?.observedAt);
  const snapshotAt = Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Date.now();
  if (snapshotAt < (state.lastSnapshotAt || 0)) {
    console.warn(`${LOG_PREFIX} Snapshot obsoleto ignorado para no revertir el progreso.`, {
      tabId: tabId ?? null,
      snapshotAt,
      lastSnapshotAt: state.lastSnapshotAt,
      lessonCount: snapshot?.lectures?.length ?? 0,
    });
    return state;
  }

  const today = localDateKey();
  const beforeToday = todaySeconds(state, today);
  const targetBefore = targetSeconds(state, today);
  const now = new Date().toISOString();

  for (const incoming of snapshot.lectures || []) {
    if (!incoming.id) continue;
    const previous = state.lectures[incoming.id];
    const completed = Boolean(incoming.completed);
    let completedAt = previous?.completedAt || null;

    if (!completed) {
      completedAt = null;
    } else if (!previous || !previous.completed) {
      completedAt = now;
    }

    state.lectures[incoming.id] = {
      ...previous,
      ...incoming,
      completed,
      completedAt,
    };
  }

  state.title = snapshot.title || state.title;
  state.lastSyncAt = now;
  state.lastSnapshotAt = snapshotAt;
  const afterToday = todaySeconds(state, today);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });

  const targetAfter = targetSeconds(state, today);
  const target = Math.max(targetBefore, targetAfter);
  if (planWindow(state.plan, today).phase === "active" &&
    tabId != null && target > 0 && beforeToday < target && afterToday >= target) {
    chrome.tabs.sendMessage(tabId, { type: "DAILY_GOAL_REACHED" }).catch(() => {});
  }
  return state;
}

async function setPlan(input) {
  const mode = input?.mode === "date" ? "date" : "duration";
  const startDate = input?.startDate;
  if (!isDateKey(startDate)) throw new Error("Elegí una fecha de inicio válida.");

  let endDate;
  let durationDays;
  if (mode === "duration") {
    const days = Number(input?.durationDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_PLAN_DAYS) {
      throw new Error(`Elegí una duración entre 1 y ${MAX_PLAN_DAYS} días.`);
    }
    durationDays = days;
    endDate = addDaysToDateKey(startDate, durationDays - 1);
  } else {
    endDate = input?.endDate;
    if (!isDateKey(endDate) || endDate < startDate) {
      throw new Error("La fecha de finalización debe ser igual o posterior al inicio.");
    }
    durationDays = daysBetweenDateKeys(startDate, endDate) + 1;
    if (durationDays > MAX_PLAN_DAYS) throw new Error(`El plan no puede superar ${MAX_PLAN_DAYS} días.`);
  }

  const state = await ensureState();
  state.plan = {
    mode,
    startDate,
    endDate,
    durationDays,
    createdAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureState().then(updateActionBadge).catch((error) => {
    console.error(`${LOG_PREFIX} No se pudo inicializar el estado.`, {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureState().then(updateActionBadge).catch((error) => {
    console.error(`${LOG_PREFIX} No se pudo actualizar el badge al iniciar Chrome.`, {
      message: error?.message || String(error),
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_STATE") {
      const state = await ensureState();
      updateActionBadge(state);
      sendResponse({ ok: true, state });
      return;
    }
    if (message?.type === "SET_PLAN") {
      const state = await enqueueStateMutation(() => setPlan(message.plan));
      updateActionBadge(state);
      sendResponse({ ok: true, state });
      return;
    }
    if (message?.type === "COURSE_SNAPSHOT") {
      console.debug(`${LOG_PREFIX} Snapshot recibido.`, {
        tabId: sender.tab?.id ?? null,
        url: sender.tab?.url || sender.url || null,
        lessonCount: message.snapshot?.lectures?.length ?? 0,
        completedCount: message.snapshot?.lectures?.filter((lesson) => lesson.completed).length ?? 0,
      });
      const state = await enqueueStateMutation(() => syncSnapshot(message.snapshot, sender.tab?.id));
      updateActionBadge(state);
      sendResponse({ ok: true, state });
      return;
    }
    sendResponse({ ok: false, error: "Mensaje desconocido." });
  })().catch((error) => {
    console.error(`${LOG_PREFIX} Error procesando ${message?.type || "mensaje"}.`, {
      message: error?.message || String(error),
      stack: error?.stack || null,
      tabId: sender.tab?.id ?? null,
      url: sender.tab?.url || sender.url || null,
    });
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
