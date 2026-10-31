const elements = {
  todayProgress: document.querySelector("#today-progress"),
  todayPercent: document.querySelector("#today-percent"),
  dailyFill: document.querySelector("#daily-fill"),
  progressTrack: document.querySelector(".progress-track"),
  goalCaption: document.querySelector("#goal-caption"),
  totalPercent: document.querySelector("#total-percent"),
  totalProgress: document.querySelector("#total-progress"),
  totalDuration: document.querySelector("#total-duration"),
  totalTrack: document.querySelector("#total-track"),
  totalFill: document.querySelector("#total-fill"),
  totalCaption: document.querySelector("#total-caption"),
  dailyTarget: document.querySelector("#daily-target"),
  planSummary: document.querySelector("#plan-summary"),
  planDays: document.querySelector("#plan-days"),
  form: document.querySelector("#plan-form"),
  formError: document.querySelector("#form-error"),
  lessonCount: document.querySelector("#lesson-count"),
  syncDot: document.querySelector("#sync-dot"),
  syncStatus: document.querySelector("#sync-status"),
  refreshButton: document.querySelector("#refresh-button"),
};

let lastAppliedDays;
const LOG_PREFIX = "[AWS SAA Tracker popup]";

function allLectures(state) {
  return Object.values(state.lectures || {});
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "0 min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  if (!rest) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

function isCompletedToday(lecture) {
  if (!lecture.completedAt) return false;
  return todayKey(new Date(lecture.completedAt)) === todayKey();
}

function updateView(state) {
  const lectures = allLectures(state);
  const targetSeconds = state.plan?.days ? state.plan.totalSeconds / state.plan.days : 0;
  const watchedToday = lectures.reduce((sum, lecture) => {
    return sum + (isCompletedToday(lecture) ? (lecture.durationSeconds || 0) : 0);
  }, 0);
  const videosToday = lectures.filter((lecture) => isCompletedToday(lecture) && lecture.durationSeconds != null).length;
  const completedCount = lectures.filter((lecture) => lecture.completed).length;
  const remaining = lectures.reduce((sum, lecture) => {
    if (lecture.completed || lecture.durationSeconds == null) return sum;
    return sum + lecture.durationSeconds;
  }, 0);
  const totalCourseSeconds = lectures.reduce((sum, lecture) => sum + (lecture.durationSeconds || 0), 0);
  const completedCourseSeconds = Math.max(0, totalCourseSeconds - remaining);
  const progress = targetSeconds > 0 ? Math.min(100, (watchedToday / targetSeconds) * 100) : 100;
  const totalProgress = totalCourseSeconds > 0 ? Math.min(100, (completedCourseSeconds / totalCourseSeconds) * 100) : 0;
  const reached = targetSeconds <= 0 || watchedToday >= targetSeconds;

  elements.todayProgress.textContent = `${formatTime(watchedToday)} / ${formatTime(targetSeconds)}`;
  elements.todayPercent.textContent = `${Math.round(progress)}%`;
  elements.dailyFill.style.width = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
  elements.goalCaption.textContent = reached
    ? `¡Meta diaria cumplida! ${videosToday} videos completados hoy.`
    : `${videosToday} videos completados hoy · te faltan ${formatTime(Math.max(0, targetSeconds - watchedToday))}.`;
  elements.goalCaption.classList.toggle("done", reached);
  elements.totalPercent.textContent = `${Math.round(totalProgress)}%`;
  elements.totalProgress.textContent = `${formatTime(completedCourseSeconds)} vistos`;
  elements.totalDuration.textContent = `de ${formatTime(totalCourseSeconds)} totales`;
  elements.totalFill.style.width = `${totalProgress}%`;
  elements.totalTrack.setAttribute("aria-valuenow", String(Math.round(totalProgress)));
  elements.totalCaption.textContent = `Te faltan ${formatTime(remaining)} de video.`;
  elements.lessonCount.textContent = `${completedCount} de ${lectures.length} lecciones completas`;
  elements.dailyTarget.textContent = formatTime(targetSeconds);
  elements.planSummary.textContent = `Duración del plan: ${state.plan?.days || 90} días`;
  elements.syncDot.classList.toggle("ready", Boolean(state.lastSyncAt));
  elements.syncStatus.textContent = state.lastSyncAt
    ? `Actualizado ${new Date(state.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Catálogo listo · escaneo al cargar el curso";

  if (lastAppliedDays == null) {
    elements.planDays.value = state.plan?.days || 90;
    lastAppliedDays = Number(elements.planDays.value);
  }
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "No se pudo cargar el progreso.");
  updateView(response.state);
}

async function syncActiveCourseTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) {
      console.error(`${LOG_PREFIX} No se encontró una pestaña activa.`);
      return { ok: false, message: "No se encontró una pestaña activa." };
    }
    const url = tab.url || tab.pendingUrl || "URL no disponible (permisos del navegador)";
    console.info(`${LOG_PREFIX} Solicitando lectura del curso.`, { tabId: tab.id, url });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_SNAPSHOT" });
    if (response?.ok) return { ok: true };
    console.error(`${LOG_PREFIX} El content script respondió, pero no detectó el curso.`, {
      tabId: tab.id,
      url: tab.url || tab.pendingUrl || null,
      response,
    });
    return { ok: false, message: response?.error || "El content script no reconoció el curso. Revisá la consola de la pestaña." };
  } catch (error) {
    const url = tab?.url || tab?.pendingUrl || "URL no disponible (permisos del navegador)";
    console.error(`${LOG_PREFIX} No se pudo contactar el content script. Puede no haberse inyectado para esta URL.`, {
      tabId: tab?.id ?? null,
      url,
      error: error?.message || String(error),
    });
    return {
      ok: false,
      message: `Sin respuesta del script en esta pestaña. Revisá la URL y la consola. (${error?.message || "sin detalle"})`,
    };
  }
}

elements.refreshButton.addEventListener("click", async () => {
  elements.refreshButton.disabled = true;
  elements.refreshButton.innerHTML = '<span aria-hidden="true">↻</span> Leyendo…';
  try {
    const result = await syncActiveCourseTab();
    await loadState();
    if (!result.ok) {
      elements.syncStatus.textContent = result.message;
    }
  } catch (error) {
    elements.syncStatus.textContent = error.message;
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.innerHTML = '<span aria-hidden="true">↻</span> Actualizar';
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formError.textContent = "";
  const days = Number(elements.planDays.value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    elements.formError.textContent = "Elegí entre 1 y 3650 días.";
    return;
  }

  const button = elements.form.querySelector("button");
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SET_PLAN", days });
    if (!response?.ok) throw new Error(response?.error || "No se pudo guardar el plan.");
    lastAppliedDays = days;
    updateView(response.state);
  } catch (error) {
    elements.formError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.awsSaaTrackerState?.newValue) {
    updateView(changes.awsSaaTrackerState.newValue);
  }
});

loadState().catch((error) => {
  elements.syncStatus.textContent = error.message;
  elements.syncDot.classList.remove("ready");
});
