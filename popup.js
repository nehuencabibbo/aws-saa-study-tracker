const elements = {
  todayProgress: document.querySelector("#today-progress"),
  todayProgressLabel: document.querySelector("#today-progress-label"),
  todayPercent: document.querySelector("#today-percent"),
  dailyFill: document.querySelector("#daily-fill"),
  progressTrack: document.querySelector(".progress-track"),
  goalCaption: document.querySelector("#goal-caption"),
  celebrateButton: document.querySelector("#celebrate-button"),
  celebrateTooltip: document.querySelector("#celebrate-tooltip"),
  totalPercent: document.querySelector("#total-percent"),
  totalProgress: document.querySelector("#total-progress"),
  totalDuration: document.querySelector("#total-duration"),
  totalTrack: document.querySelector("#total-track"),
  totalFill: document.querySelector("#total-fill"),
  totalCaption: document.querySelector("#total-caption"),
  planSummary: document.querySelector("#plan-summary"),
  startDate: document.querySelector("#start-date"),
  planDays: document.querySelector("#plan-days"),
  endDate: document.querySelector("#end-date"),
  planEditor: document.querySelector("#plan-editor"),
  editPlanButton: document.querySelector("#edit-plan-button"),
  durationField: document.querySelector("#duration-field"),
  deadlineField: document.querySelector("#deadline-field"),
  planPreview: document.querySelector("#plan-preview"),
  planModeButtons: [...document.querySelectorAll("[data-plan-mode]")],
  form: document.querySelector("#plan-form"),
  formError: document.querySelector("#form-error"),
  lessonCount: document.querySelector("#lesson-count"),
  syncDot: document.querySelector("#sync-dot"),
  syncStatus: document.querySelector("#sync-status"),
  refreshButton: document.querySelector("#refresh-button"),
};

let selectedPlanMode = "duration";
let planFormDirty = false;
let planEditorOpen = false;
let latestState;
const LOG_PREFIX = "[AWS SAA Tracker popup]";

function allLectures(state) {
  return Object.values(state.lectures || {});
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenDateKeys(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

function formatDate(dateKey) {
  if (!isDateKey(dateKey)) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

function planTiming(plan, today = todayKey()) {
  if (!isDateKey(plan?.startDate) || !isDateKey(plan?.endDate)) {
    const days = Math.max(1, Number(plan?.durationDays ?? plan?.days) || 90);
    return { phase: "active", daysRemaining: days };
  }
  if (today < plan.startDate) {
    return { phase: "upcoming", daysRemaining: daysBetweenDateKeys(plan.startDate, plan.endDate) + 1 };
  }
  if (today > plan.endDate) return { phase: "overdue", daysRemaining: 0 };
  return { phase: "active", daysRemaining: daysBetweenDateKeys(today, plan.endDate) + 1 };
}

function updatePlanModeControls() {
  const durationMode = selectedPlanMode === "duration";
  elements.durationField.hidden = !durationMode;
  elements.deadlineField.hidden = durationMode;
  elements.planDays.required = durationMode;
  elements.endDate.required = !durationMode;
  elements.planModeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.planMode === selectedPlanMode));
  });
}

function updatePlanPreview() {
  const startDate = elements.startDate.value;
  if (!isDateKey(startDate)) {
    elements.planPreview.textContent = "Elegí una fecha de inicio.";
    return;
  }
  elements.endDate.min = startDate;

  let endDate;
  let durationDays;
  if (selectedPlanMode === "duration") {
    durationDays = Number(elements.planDays.value);
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
      elements.planPreview.textContent = "La duración debe ser de 1 a 3650 días.";
      return;
    }
    endDate = addDaysToDateKey(startDate, durationDays - 1);
    elements.endDate.value = endDate;
  } else {
    endDate = elements.endDate.value;
    if (!isDateKey(endDate) || endDate < startDate) {
      elements.planPreview.textContent = "Elegí una fecha final igual o posterior al inicio.";
      return;
    }
    durationDays = daysBetweenDateKeys(startDate, endDate) + 1;
    if (durationDays > 3650) {
      elements.planPreview.textContent = "El plan no puede superar los 3650 días.";
      return;
    }
  }

  elements.endDate.min = startDate;
  const today = todayKey();
  const timing = planTiming({ startDate, endDate }, today);
  if (timing.phase === "overdue") {
    elements.planPreview.textContent = "La fecha final ya pasó. Elegí una fecha futura para calcular el ritmo.";
    return;
  }

  if (!latestState) {
    elements.planPreview.textContent = `Finaliza ${formatDate(endDate)} · ${durationDays} ${durationDays === 1 ? "día" : "días"}`;
    return;
  }

  const lectures = allLectures(latestState);
  const remaining = lectures.reduce((sum, lecture) => {
    if (lecture.completed || lecture.durationSeconds == null) return sum;
    return sum + lecture.durationSeconds;
  }, 0);
  if (remaining <= 0) {
    elements.planPreview.textContent = "Curso completo: no quedan minutos de video pendientes.";
    return;
  }
  const watchedToday = lectures.reduce((sum, lecture) => {
    return sum + (isCompletedToday(lecture) ? (lecture.durationSeconds || 0) : 0);
  }, 0);
  const secondsToSchedule = remaining + (timing.phase === "active" ? watchedToday : 0);
  const dailyRate = secondsToSchedule / Math.max(1, timing.daysRemaining);
  const daysLabel = `${timing.daysRemaining} ${timing.daysRemaining === 1 ? "día" : "días"}`;
  elements.planPreview.textContent = timing.phase === "upcoming"
    ? `Ritmo estimado: ${formatTime(dailyRate)} / día · empieza ${formatDate(startDate)} · termina ${formatDate(endDate)}`
    : `Ritmo estimado: ${formatTime(dailyRate)} / día · ${daysLabel} hasta ${formatDate(endDate)}`;
}

function syncPlanForm(plan) {
  selectedPlanMode = plan?.mode === "date" ? "date" : "duration";
  elements.startDate.value = plan?.startDate || todayKey();
  elements.endDate.value = plan?.endDate || "";
  elements.planDays.value = plan?.durationDays || plan?.days || 90;
  elements.endDate.min = elements.startDate.value;
  updatePlanModeControls();
  updatePlanPreview();
  planFormDirty = false;
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

function formatPositiveTime(seconds) {
  return formatTime(seconds > 0 ? Math.max(60, seconds) : 0);
}

function isCompletedToday(lecture) {
  if (!lecture.completedAt) return false;
  return todayKey(new Date(lecture.completedAt)) === todayKey();
}

function updateView(state) {
  latestState = state;
  const lectures = allLectures(state);
  const timing = planTiming(state.plan);
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
  const targetSeconds = timing.phase === "overdue" || remaining <= 0
    ? 0
    : (remaining + (timing.phase === "active" ? watchedToday : 0)) / Math.max(1, timing.daysRemaining);
  const dailyGoalActive = timing.phase === "active" && remaining > 0;
  const courseComplete = totalCourseSeconds > 0 && remaining <= 0;
  const progress = dailyGoalActive && targetSeconds > 0
    ? Math.min(100, (watchedToday / targetSeconds) * 100)
    : 0;
  const progressPercent = Math.floor(progress);
  const dailyRemainingSeconds = Math.max(0, targetSeconds - watchedToday);
  const totalProgress = totalCourseSeconds > 0 ? Math.min(100, (completedCourseSeconds / totalCourseSeconds) * 100) : 0;
  const reached = dailyGoalActive && watchedToday >= targetSeconds;

  elements.todayProgress.textContent = dailyGoalActive
    ? `${formatTime(watchedToday)} / ${formatPositiveTime(targetSeconds)}`
    : "—";
  elements.todayProgressLabel.textContent = dailyGoalActive ? "visto / objetivo" : "sin meta activa";
  elements.todayPercent.textContent = dailyGoalActive ? `${progressPercent}%` : "—";
  elements.progressTrack.hidden = !dailyGoalActive;
  elements.dailyFill.style.width = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(progressPercent));
  const dailyAccessibleText = dailyGoalActive
    ? `${formatTime(watchedToday)} de ${formatPositiveTime(targetSeconds)} completados hoy`
    : courseComplete
      ? "El curso está completo; no hay meta diaria activa"
      : timing.phase === "upcoming"
        ? `El plan aún no empieza; comienza el ${formatDate(state.plan.startDate)}`
        : timing.phase === "overdue"
          ? `El plazo venció el ${formatDate(state.plan.endDate)}`
          : "No hay una meta diaria activa";
  elements.progressTrack.setAttribute("aria-valuetext", dailyAccessibleText);
  if (courseComplete) {
    elements.goalCaption.textContent = "Curso completo: no quedan minutos de video pendientes.";
  } else if (timing.phase === "upcoming") {
    elements.goalCaption.textContent = `Aún no empieza · tu plan comienza el ${formatDate(state.plan.startDate)}.`;
  } else if (timing.phase === "overdue") {
    elements.goalCaption.textContent = "Plazo vencido · elegí una fecha futura para retomar el ritmo.";
  } else if (reached) {
    elements.goalCaption.textContent = `Meta diaria cumplida · ${videosToday} ${videosToday === 1 ? "lección completada" : "lecciones completadas"} hoy.`;
  } else {
    elements.goalCaption.textContent = `Te faltan ${formatPositiveTime(dailyRemainingSeconds)} de video para la meta de hoy · ${videosToday} ${videosToday === 1 ? "lección completa" : "lecciones completas"}.`;
  }
  elements.goalCaption.classList.toggle("done", reached || courseComplete);
  const celebrateTooltip = reached
    ? "Meta diaria al 100% · tocá para lanzar confeti otra vez."
    : "Disponible solo al alcanzar el 100% de la meta diaria.";
  elements.celebrateButton.disabled = !reached;
  elements.celebrateButton.setAttribute("aria-label", reached
    ? "Lanzar confeti: meta diaria completada"
    : "Confeti disponible solo al alcanzar el 100% de la meta diaria");
  elements.celebrateTooltip.dataset.tooltip = celebrateTooltip;
  elements.celebrateTooltip.setAttribute("aria-label", celebrateTooltip);
  const totalProgressPercent = Math.floor(totalProgress);
  elements.totalPercent.textContent = `${totalProgressPercent}%`;
  elements.totalProgress.textContent = `${formatTime(completedCourseSeconds)} vistos`;
  elements.totalDuration.textContent = `de ${formatTime(totalCourseSeconds)} totales`;
  elements.totalFill.style.width = `${totalProgress}%`;
  elements.totalTrack.setAttribute("aria-valuenow", String(totalProgressPercent));
  elements.totalTrack.setAttribute("aria-valuetext", `${formatTime(completedCourseSeconds)} de ${formatTime(totalCourseSeconds)} completados`);
  elements.totalCaption.textContent = remaining <= 0
    ? "Curso completo · no quedan horas de video."
    : `Te faltan ${formatTime(remaining)} de video.`;
  elements.lessonCount.textContent = `${completedCount} de ${lectures.length} lecciones completas`;
  if (timing.phase === "upcoming") {
    elements.planSummary.textContent = `Inicio ${formatDate(state.plan.startDate)} → ${formatDate(state.plan.endDate)} · ${timing.daysRemaining} días`;
  } else if (timing.phase === "overdue") {
    elements.planSummary.textContent = `Inicio ${formatDate(state.plan.startDate)} · venció ${formatDate(state.plan.endDate)}`;
  } else {
    const daysLabel = `${timing.daysRemaining} ${timing.daysRemaining === 1 ? "día" : "días"}`;
    elements.planSummary.textContent = `Inicio ${formatDate(state.plan.startDate)} → ${formatDate(state.plan.endDate)} · quedan ${daysLabel}`;
  }
  elements.syncDot.classList.toggle("ready", Boolean(state.lastSyncAt));
  elements.syncDot.classList.remove("error", "loading");
  if (state.lastSyncAt) {
    const syncedAt = new Date(state.lastSyncAt);
    const syncedDate = syncedAt.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
    const syncedTime = syncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    elements.syncStatus.textContent = `Última lectura guardada: ${syncedDate} a las ${syncedTime}. Tocá Actualizar para leer la pestaña activa.`;
  } else {
    elements.syncStatus.textContent = "Todavía no hay una lectura guardada. Abrí una lección del curso y tocá Actualizar.";
  }
  elements.syncStatus.classList.remove("error");

  if (!planFormDirty) syncPlanForm(state.plan);
  else updatePlanPreview();
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "No se pudo cargar el progreso.");
  updateView(response.state);
}

function courseDiagnosticMessage(diagnostic) {
  switch (diagnostic?.code) {
    case "sidebar_not_found":
      return "No encontré el menú de lecciones. Abrí una página del curso SAA-C03 y probá de nuevo.";
    case "path_course_id_mismatch":
    case "sidebar_course_id_mismatch":
      return "Esta página corresponde a otro curso, no al SAA-C03.";
    case "course_id_not_identified":
      return "No pude confirmar que esta página sea del curso SAA-C03. Abrí una lección y probá de nuevo.";
    case "no_lessons_found":
      return "Detecté el menú del curso, pero no encontré lecciones. Recargá la página y probá de nuevo.";
    default:
      return "No pude confirmar el curso SAA-C03 en esta pestaña. Abrí una lección y probá de nuevo.";
  }
}

function isContentScriptConnectionError(error) {
  return /could not establish connection|receiving end does not exist|extension context invalidated|message port closed/i
    .test(error?.message || String(error));
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
    if (response?.ok) {
      const lessonCount = Object.keys(response.state?.lectures || {}).length;
      return { ok: true, message: `Curso detectado en esta pestaña · ${lessonCount} lecciones en el catálogo.` };
    }
    console.error(`${LOG_PREFIX} El content script respondió, pero no detectó el curso.`, {
      tabId: tab.id,
      url: tab.url || tab.pendingUrl || null,
      response,
    });
    return {
      ok: false,
      message: courseDiagnosticMessage(response?.diagnostic),
      diagnostic: response?.diagnostic,
    };
  } catch (error) {
    const url = tab?.url || tab?.pendingUrl || "URL no disponible (permisos del navegador)";
    const message = error?.message || String(error);
    const isCoursePage = /^https:\/\/learn\.cantrill\.io\/courses\//i.test(url);
    const connectionError = isContentScriptConnectionError(error);
    const logDetails = {
      tabId: tab?.id ?? null,
      url,
      error: message,
      stack: error?.stack || null,
      likelyCause: connectionError
        ? (isCoursePage ? "content_script_stale_or_missing" : "no_content_script_for_url")
        : "unexpected_error",
    };
    const logMessage = `${LOG_PREFIX} No se pudo contactar el content script: ${JSON.stringify(logDetails)}`;
    if (connectionError) console.warn(logMessage);
    else console.error(logMessage);
    return {
      ok: false,
      message: connectionError && isCoursePage
        ? "La extensión se recargó, pero esta pestaña conserva el script anterior. Recargá la página del curso y volvé a tocar Actualizar."
        : "La pestaña no respondió. Abrí una lección de learn.cantrill.io y tocá Actualizar.",
    };
  }
}

elements.refreshButton.addEventListener("click", async () => {
  elements.refreshButton.disabled = true;
  elements.refreshButton.innerHTML = '<span class="button-spinner" aria-hidden="true"></span> Leyendo…';
  elements.syncDot.classList.remove("ready", "error");
  elements.syncDot.classList.add("loading");
  elements.syncStatus.textContent = "Leyendo la pestaña activa y comprobando el curso.";
  elements.syncStatus.classList.remove("error");
  try {
    const result = await syncActiveCourseTab();
    await loadState();
    elements.syncDot.classList.toggle("ready", result.ok);
    elements.syncDot.classList.toggle("error", !result.ok);
    elements.syncStatus.textContent = result.message;
    elements.syncStatus.classList.toggle("error", !result.ok);
  } catch (error) {
    elements.syncDot.classList.remove("loading", "ready");
    elements.syncDot.classList.add("error");
    elements.syncStatus.textContent = error.message;
    elements.syncStatus.classList.add("error");
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 6A5.5 5.5 0 0 0 3.3 4.3L2.2 5.5M2.2 5.5V2.8m0 2.7H5M2.8 10A5.5 5.5 0 0 0 12.7 11.7l1.1-1.2m0 0v2.7m0-2.7H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Actualizar';
  }
});

elements.celebrateButton.addEventListener("click", async () => {
  if (elements.celebrateButton.disabled) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error("No se encontró una pestaña activa.");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CELEBRATE_DAILY_GOAL" });
    if (!response?.ok) throw new Error("Abrí una lección del curso para mostrar el confeti.");
  } catch (error) {
    console.error(`${LOG_PREFIX} No se pudo mostrar el confeti en la pestaña activa.`, {
      message: error?.message || String(error),
    });
    elements.celebrateTooltip.dataset.tooltip = "Abrí una lección de learn.cantrill.io para mostrar el confeti.";
    elements.celebrateTooltip.setAttribute("aria-label", elements.celebrateTooltip.dataset.tooltip);
    setTimeout(() => {
      if (latestState) updateView(latestState);
    }, 3500);
  }
});

elements.planModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedPlanMode = button.dataset.planMode;
    planFormDirty = true;
    elements.formError.textContent = "";
    updatePlanModeControls();
    updatePlanPreview();
  });
});

elements.editPlanButton.addEventListener("click", () => {
  planEditorOpen = !planEditorOpen;
  elements.planEditor.hidden = !planEditorOpen;
  elements.editPlanButton.setAttribute("aria-expanded", String(planEditorOpen));
  elements.editPlanButton.textContent = planEditorOpen ? "Cerrar" : "Editar fechas";
  if (planEditorOpen) elements.startDate.focus();
});

[elements.startDate, elements.planDays, elements.endDate].forEach((input) => {
  input.addEventListener("input", () => {
    planFormDirty = true;
    elements.formError.textContent = "";
    updatePlanPreview();
  });
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formError.textContent = "";
  const plan = {
    mode: selectedPlanMode,
    startDate: elements.startDate.value,
  };
  if (!isDateKey(plan.startDate)) {
    elements.formError.textContent = "Elegí una fecha de inicio válida.";
    return;
  }
  if (selectedPlanMode === "duration") {
    plan.durationDays = Number(elements.planDays.value);
    if (!Number.isInteger(plan.durationDays) || plan.durationDays < 1 || plan.durationDays > 3650) {
      elements.formError.textContent = "Elegí una duración entre 1 y 3650 días.";
      return;
    }
  } else {
    plan.endDate = elements.endDate.value;
    const durationDays = isDateKey(plan.endDate) ? daysBetweenDateKeys(plan.startDate, plan.endDate) + 1 : 0;
    if (durationDays < 1 || durationDays > 3650) {
      elements.formError.textContent = "Elegí una fecha final posterior al inicio, dentro de los próximos 3650 días.";
      return;
    }
  }

  const button = elements.form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SET_PLAN", plan });
    if (!response?.ok) throw new Error(response?.error || "No se pudo guardar el plan.");
    planFormDirty = false;
    planEditorOpen = false;
    elements.planEditor.hidden = true;
    elements.editPlanButton.setAttribute("aria-expanded", "false");
    elements.editPlanButton.textContent = "Editar fechas";
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
  elements.syncDot.classList.add("error");
  elements.syncStatus.textContent = error.message;
  elements.syncStatus.classList.add("error");
});
