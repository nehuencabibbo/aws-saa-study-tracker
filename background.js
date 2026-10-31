const STORAGE_KEY = "awsSaaTrackerState";
const COURSE_DATA_PATH = "assets/course-data.json";
const DEFAULT_PLAN_DAYS = 90;
const LOG_PREFIX = "[AWS SAA Tracker service worker]";
let initializationPromise;

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

  return {
    version: 1,
    courseId: catalog.id,
    title: catalog.title,
    lectures,
    plan: {
      days: DEFAULT_PLAN_DAYS,
      totalSeconds: remainingSeconds(lectures),
      createdAt: new Date().toISOString(),
    },
    lastSyncAt: null,
  };
}

async function ensureState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) return stored[STORAGE_KEY];

  if (!initializationPromise) {
    initializationPromise = (async () => {
      const latest = await chrome.storage.local.get(STORAGE_KEY);
      if (latest[STORAGE_KEY]) return latest[STORAGE_KEY];
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

function todaySeconds(state, dateKey = localDateKey()) {
  return Object.values(state.lectures).reduce((total, lecture) => {
    if (!lecture.completedAt || localDateKey(new Date(lecture.completedAt)) !== dateKey) return total;
    return total + (lecture.durationSeconds || 0);
  }, 0);
}

function targetSeconds(state) {
  if (!state.plan?.days) return 0;
  return state.plan.totalSeconds / state.plan.days;
}

async function syncSnapshot(snapshot, tabId) {
  const state = await ensureState();
  const today = localDateKey();
  const beforeToday = todaySeconds(state, today);
  const now = new Date().toISOString();
  const isFirstSync = !state.lastSyncAt;

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
  if (isFirstSync && state.plan) {
    state.plan.totalSeconds = remainingSeconds(state.lectures);
  }
  const afterToday = todaySeconds(state, today);
  await chrome.storage.local.set({ [STORAGE_KEY]: state });

  const target = targetSeconds(state);
  if (tabId != null && target > 0 && beforeToday < target && afterToday >= target) {
    chrome.tabs.sendMessage(tabId, { type: "DAILY_GOAL_REACHED" }).catch(() => {});
  }
  return state;
}

async function setPlan(days) {
  const safeDays = Math.max(1, Math.min(3650, Math.floor(Number(days) || DEFAULT_PLAN_DAYS)));
  const state = await ensureState();
  state.plan = {
    days: safeDays,
    totalSeconds: remainingSeconds(state.lectures),
    createdAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureState().catch((error) => {
    console.error(`${LOG_PREFIX} No se pudo inicializar el estado.`, {
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_STATE") {
      sendResponse({ ok: true, state: await ensureState() });
      return;
    }
    if (message?.type === "SET_PLAN") {
      sendResponse({ ok: true, state: await setPlan(message.days) });
      return;
    }
    if (message?.type === "COURSE_SNAPSHOT") {
      console.debug(`${LOG_PREFIX} Snapshot recibido.`, {
        tabId: sender.tab?.id ?? null,
        url: sender.tab?.url || sender.url || null,
        lessonCount: message.snapshot?.lectures?.length ?? 0,
        completedCount: message.snapshot?.lectures?.filter((lesson) => lesson.completed).length ?? 0,
      });
      sendResponse({ ok: true, state: await syncSnapshot(message.snapshot, sender.tab?.id) });
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
