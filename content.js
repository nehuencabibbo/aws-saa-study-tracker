const COURSE_ID = "aws-saa-c03";
const PLATFORM_COURSE_ID = "1820301";
const LOG_PREFIX = "[AWS SAA Tracker]";
const COMPLETION_CONTROL_SELECTOR = "#lecture_complete_button, #lecture_content_complete_button";
let updateTimer;
let lastScanLogKey = "";
let lastScanDiagnostic = null;
let observer = null;
let extensionContextInvalidated = false;
let celebrationOverlay = null;
let quizCelebrationOverlay = null;
let quizCelebrationTimer = null;
let observedQuizNode = null;
let observedQuizKey = "";
let quizCompletionArmed = false;
const completionRetryTimers = new Set();

function errorDetails(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function handleExtensionContextError(error, source) {
  const details = errorDetails(error);
  if (!/extension context invalidated|context invalidated/i.test(details.message)) return false;

  if (!extensionContextInvalidated) {
    extensionContextInvalidated = true;
    clearTimeout(updateTimer);
    for (const timer of completionRetryTimers) clearTimeout(timer);
    completionRetryTimers.clear();
    observer?.disconnect();
    console.warn(`${LOG_PREFIX} La extensión se recargó mientras esta pestaña seguía abierta. Recargá la página del curso para conectar la nueva versión.`, {
      source,
      ...pageDetails(),
      ...details,
    });
  }
  return true;
}

function logRuntimeMessageError(label, error, source) {
  if (handleExtensionContextError(error, source)) return;
  const details = errorDetails(error);
  console.error(`${LOG_PREFIX} ${label}`, { source, ...pageDetails(), ...details });
}

function pageDetails() {
  return {
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    readyState: document.readyState,
  };
}

function currentLectureId() {
  const match = location.pathname.match(/^\/courses\/(\d+)\/lectures\/(\d+)(?:\/|$)/);
  return match?.[1] === PLATFORM_COURSE_ID ? match[2] : null;
}

function parseDuration(title) {
  const match = title.match(/\((\d+):(\d{2})(?::(\d{2}))?\)\s*$/);
  if (!match) return { title: title.trim(), durationSeconds: null };
  const durationSeconds = match[3]
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number(match[1]) * 60 + Number(match[2]);
  return {
    title: title.slice(0, match.index).trim(),
    durationSeconds,
  };
}

function scanCourse() {
  const sidebar = document.querySelector("#courseSidebar, .course-sidebar");
  if (!sidebar) {
    return {
      snapshot: null,
      diagnostic: {
        code: "sidebar_not_found",
        message: "No se encontró #courseSidebar ni .course-sidebar.",
        ...pageDetails(),
      },
    };
  }

  const pathCourseId = location.pathname.match(/^\/courses\/(\d+)(?:\/|$)/)?.[1];
  const sidebarCourseIds = [...new Set(
    [...sidebar.querySelectorAll("[data-course-id]")]
      .map((element) => element.getAttribute("data-course-id"))
      .filter(Boolean),
  )];
  const idDetails = { pathCourseId: pathCourseId || null, sidebarCourseIds, ...pageDetails() };
  if (pathCourseId && pathCourseId !== PLATFORM_COURSE_ID) {
    return { snapshot: null, diagnostic: { code: "path_course_id_mismatch", ...idDetails } };
  }
  if (sidebarCourseIds.some((id) => id !== PLATFORM_COURSE_ID)) {
    return { snapshot: null, diagnostic: { code: "sidebar_course_id_mismatch", ...idDetails } };
  }
  if (pathCourseId !== PLATFORM_COURSE_ID && !sidebarCourseIds.includes(PLATFORM_COURSE_ID)) {
    return { snapshot: null, diagnostic: { code: "course_id_not_identified", ...idDetails } };
  }

  const lessons = [];
  for (const section of sidebar.querySelectorAll(".course-section")) {
    const sectionTitle = section.querySelector(".section-title")?.textContent?.replace(/\s+/g, " ").trim() || "Sin sección";
    for (const item of section.querySelectorAll("li[data-lecture-id]")) {
      const id = item.getAttribute("data-lecture-id");
      const rawTitle = item.querySelector(".lecture-name")?.textContent?.replace(/\s+/g, " ").trim() || "Lección";
      const parsed = parseDuration(rawTitle);
      const completed = item.classList.contains("completed") ||
        item.querySelector('[aria-label="Completed item"]') !== null;
      lessons.push({
        id,
        url: item.getAttribute("data-lecture-url") || item.querySelector("a.item")?.getAttribute("href") || "",
        title: parsed.title,
        sectionTitle,
        durationSeconds: parsed.durationSeconds,
        completed,
      });
    }
  }

  if (!lessons.length) {
    return {
      snapshot: null,
      diagnostic: {
        code: "no_lessons_found",
        sectionsFound: sidebar.querySelectorAll(".course-section").length,
        lectureNodesFound: sidebar.querySelectorAll("li[data-lecture-id]").length,
        ...idDetails,
      },
    };
  }
  return {
    snapshot: {
      courseId: COURSE_ID,
      title: document.querySelector(".course-sidebar-head h2")?.textContent?.replace(/\s+/g, " ").trim() || "AWS SAA-C03",
      currentLectureId: currentLectureId(),
      lectures: lessons,
      observedAt: Date.now(),
    },
    diagnostic: idDetails,
  };
}

function scrapeCourse(source = "automatic") {
  const result = scanCourse();
  if (!result.snapshot) {
    lastScanDiagnostic = result.diagnostic;
    const key = `${result.diagnostic.code}:${result.diagnostic.href}:${result.diagnostic.pathCourseId}:${result.diagnostic.sidebarCourseIds}`;
    if (key !== lastScanLogKey) {
      console.error(`${LOG_PREFIX} No se pudo reconocer el curso.`, { source, ...result.diagnostic });
      lastScanLogKey = key;
    }
    return null;
  }

  lastScanDiagnostic = null;
  const completed = result.snapshot.lectures.filter((lesson) => lesson.completed).length;
  const signature = `${result.snapshot.lectures.length}:${completed}:${result.snapshot.lectures.map((lesson) => `${lesson.id}:${Number(lesson.completed)}`).join(",")}`;
  if (signature !== lastScanLogKey) {
    console.info(`${LOG_PREFIX} Curso detectado y parseado.`, {
      source,
      ...result.diagnostic,
      courseId: result.snapshot.courseId,
      title: result.snapshot.title,
      lessons: result.snapshot.lectures.length,
      completed,
    });
    lastScanLogKey = signature;
  }
  return result.snapshot;
}

async function sendSnapshot(source = "automatic sync") {
  if (extensionContextInvalidated) return;
  const snapshot = scrapeCourse(source);
  if (!snapshot) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "COURSE_SNAPSHOT", snapshot });
    if (!response?.ok) console.error(`${LOG_PREFIX} El service worker rechazó el snapshot.`, response);
  } catch (error) {
    logRuntimeMessageError("No se pudo enviar el snapshot al service worker.", error, source);
  }
}

function scheduleSnapshot(source = "sidebar mutation") {
  if (extensionContextInvalidated) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => sendSnapshot(source), 350);
}

function scheduleCompletionSync() {
  if (extensionContextInvalidated) return;
  console.info(`${LOG_PREFIX} Se pulsó el control de completar lección; voy a volver a leer el sidebar.`, pageDetails());
  [0, 500, 1500, 3500].forEach((delay) => {
    const timer = setTimeout(() => {
      completionRetryTimers.delete(timer);
      sendSnapshot(`completion action retry ${delay}ms`);
    }, delay);
    completionRetryTimers.add(timer);
  });
}

function isInsideSidebar(node) {
  if (!(node instanceof Element)) return false;
  return node.matches("#courseSidebar, .course-sidebar") ||
    Boolean(node.closest("#courseSidebar, .course-sidebar"));
}

function containsSidebar(node) {
  if (!(node instanceof Element)) return false;
  return node.matches("#courseSidebar, .course-sidebar") ||
    Boolean(node.querySelector("#courseSidebar, .course-sidebar"));
}

function isInsideQuiz(node) {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  return Boolean(element && (element.id === "quiz-app" || element.closest("#quiz-app")));
}

function containsQuiz(node) {
  if (!(node instanceof Element)) return false;
  return node.id === "quiz-app" || Boolean(node.querySelector("#quiz-app"));
}

function isTrackedCoursePage() {
  const pathCourseId = location.pathname.match(/^\/courses\/(\d+)(?:\/|$)/)?.[1];
  if (pathCourseId) return pathCourseId === PLATFORM_COURSE_ID;
  const sidebar = document.querySelector("#courseSidebar, .course-sidebar");
  return [...(sidebar?.querySelectorAll("[data-course-id]") || [])]
    .some((element) => element.getAttribute("data-course-id") === PLATFORM_COURSE_ID);
}

function quizDisplayName() {
  const heading = document.querySelector("#lecture_heading")?.textContent?.replace(/\s+/g, " ").trim() || "";
  const shortName = heading.replace(/\s*(?:section\s+)?quiz\s*$/i, "").trim();
  return shortName || heading || "Quiz de sección";
}

function celebrateQuiz(name) {
  if (!quizCelebrationOverlay?.isConnected) {
    const style = document.createElement("style");
    style.textContent = `
      .aws-saa-tracker-quiz-celebration{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;font-family:system-ui,sans-serif}
      .aws-saa-tracker-quiz-toast{position:absolute;top:24px;left:50%;box-sizing:border-box;display:flex;align-items:center;gap:13px;max-width:calc(100vw - 32px);padding:13px 19px 13px 13px;border:1px solid #a99cff;border-radius:18px;background:linear-gradient(125deg,#25234d 0%,#443d7b 58%,#554a91 100%);color:#fff;box-shadow:0 14px 38px #211b4c55;animation:aws-saa-quiz-pop .55s cubic-bezier(.2,.9,.25,1.25) both}
      .aws-saa-tracker-quiz-medal{position:relative;width:42px;height:42px;display:grid;flex:none;place-items:center;border-radius:14px;background:linear-gradient(145deg,#ffe38c,#e5aa35);color:#3d315e;font-size:22px;box-shadow:0 4px 12px #17152f55;animation:aws-saa-quiz-medal .8s ease-out both}
      .aws-saa-tracker-quiz-medal::after{position:absolute;inset:-5px;border:1px solid #fff8;border-radius:17px;content:"";animation:aws-saa-quiz-ring 1.2s ease-out .15s both}
      .aws-saa-tracker-quiz-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
      .aws-saa-tracker-quiz-copy strong{font-size:14px;line-height:1.25;letter-spacing:.1px}
      .aws-saa-tracker-quiz-copy span{max-width:calc(100vw - 118px);overflow:hidden;color:#e4e0ff;font-size:12px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
      @keyframes aws-saa-quiz-pop{from{opacity:0;top:4px;transform:translate(-50%,-8px) scale(.9)}to{opacity:1;top:24px;transform:translate(-50%,0) scale(1)}}
      @keyframes aws-saa-quiz-medal{0%{transform:rotate(-18deg) scale(.5)}65%{transform:rotate(8deg) scale(1.14)}100%{transform:rotate(0) scale(1)}}
      @keyframes aws-saa-quiz-ring{0%{opacity:.85;transform:scale(.75)}100%{opacity:0;transform:scale(1.35)}}
      @media(prefers-reduced-motion:reduce){.aws-saa-tracker-quiz-toast,.aws-saa-tracker-quiz-medal,.aws-saa-tracker-quiz-medal::after{animation:none!important}}
    `;
    quizCelebrationOverlay = document.createElement("div");
    quizCelebrationOverlay.className = "aws-saa-tracker-quiz-celebration";
    quizCelebrationOverlay.setAttribute("role", "status");
    quizCelebrationOverlay.setAttribute("aria-live", "polite");
    quizCelebrationOverlay.setAttribute("aria-atomic", "true");
    quizCelebrationOverlay.append(style);
    document.documentElement.append(quizCelebrationOverlay);
  }

  const toast = document.createElement("div");
  toast.className = "aws-saa-tracker-quiz-toast";
  const medal = document.createElement("span");
  medal.className = "aws-saa-tracker-quiz-medal";
  medal.setAttribute("aria-hidden", "true");
  medal.textContent = "★";
  const copy = document.createElement("span");
  copy.className = "aws-saa-tracker-quiz-copy";
  const title = document.createElement("strong");
  title.textContent = "¡Quiz completado!";
  const subtitle = document.createElement("span");
  subtitle.textContent = name ? `Terminaste ${name}` : "Un paso más cerca de la certificación";
  copy.append(title, subtitle);
  toast.append(medal, copy);
  quizCelebrationOverlay.querySelector(".aws-saa-tracker-quiz-toast")?.remove();
  quizCelebrationOverlay.append(toast);

  clearTimeout(quizCelebrationTimer);
  const overlay = quizCelebrationOverlay;
  quizCelebrationTimer = setTimeout(() => {
    overlay.remove();
    if (quizCelebrationOverlay === overlay) {
      quizCelebrationOverlay = null;
      quizCelebrationTimer = null;
    }
  }, 5200);
}

function syncQuizCompletionState() {
  if (!isTrackedCoursePage()) {
    observedQuizNode = null;
    observedQuizKey = "";
    quizCompletionArmed = false;
    return;
  }

  const quiz = document.querySelector("#quiz-app .quiz");
  if (!quiz) {
    observedQuizNode = null;
    observedQuizKey = "";
    quizCompletionArmed = false;
    return;
  }

  const lectureId = location.pathname.match(/\/lectures\/(\d+)(?:\/|$)/)?.[1] || location.pathname;
  const quizKey = `${lectureId}:${quiz.id || "quiz"}`;
  const finished = quiz.classList.contains("finished");
  if (quiz !== observedQuizNode || quizKey !== observedQuizKey) {
    observedQuizNode = quiz;
    observedQuizKey = quizKey;
    quizCompletionArmed = !finished;
    return;
  }

  if (!finished) {
    quizCompletionArmed = true;
    return;
  }
  if (!quizCompletionArmed) return;

  quizCompletionArmed = false;
  celebrateQuiz(quizDisplayName());
}

function celebrationDuration(seconds) {
  const minutes = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${minutes} min`;
  return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
}

function celebrateGoal(message = "🎉 ¡Meta diaria cumplida!", pieceCount = 84, colors = null) {
  if (!celebrationOverlay?.isConnected) {
    const style = document.createElement("style");
    style.textContent = `
      .aws-saa-tracker-celebration{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;font-family:system-ui,sans-serif}
      .aws-saa-tracker-banner{position:absolute;top:24px;left:50%;transform:translateX(-50%);box-sizing:border-box;max-width:calc(100vw - 32px);padding:14px 22px;border-radius:999px;background:#142b40;color:white;font-size:16px;font-weight:700;text-align:center;box-shadow:0 12px 36px #15283a66;animation:aws-saa-banner-in .45s ease-out both}
      .aws-saa-tracker-burst{position:absolute;inset:0;overflow:hidden}
      .aws-saa-tracker-piece{position:absolute;top:-18px;width:9px;height:14px;border-radius:3px;animation:aws-saa-fall var(--fall-time) linear var(--delay) forwards;left:var(--left);background:var(--color);transform:rotate(var(--spin))}
      @keyframes aws-saa-fall{to{top:110vh;transform:translateX(var(--drift)) rotate(calc(var(--spin) + 720deg));opacity:.8}}
      @keyframes aws-saa-banner-in{from{opacity:0;top:0}to{opacity:1;top:24px}}
      @media(prefers-reduced-motion:reduce){.aws-saa-tracker-piece{animation-duration:1ms!important}.aws-saa-tracker-banner{animation:none}}
    `;
    celebrationOverlay = document.createElement("div");
    celebrationOverlay.className = "aws-saa-tracker-celebration";
    celebrationOverlay.setAttribute("aria-hidden", "true");
    const banner = document.createElement("div");
    banner.className = "aws-saa-tracker-banner";
    celebrationOverlay.append(style, banner);
    document.documentElement.append(celebrationOverlay);
  }

  const overlay = celebrationOverlay;
  overlay.querySelector(".aws-saa-tracker-banner").textContent = message;
  const burst = document.createElement("div");
  burst.className = "aws-saa-tracker-burst";
  const burstColors = colors || ["#3f6d8c", "#527d99", "#18344e", "#8bb6ce", "#d7a84a"];
  for (let i = 0; i < pieceCount; i += 1) {
    const piece = document.createElement("i");
    piece.className = "aws-saa-tracker-piece";
    piece.style.setProperty("--left", `${Math.random() * 100}%`);
    piece.style.setProperty("--color", burstColors[i % burstColors.length]);
    piece.style.setProperty("--delay", `${Math.random() * 1.1}s`);
    piece.style.setProperty("--fall-time", `${2.4 + Math.random() * 1.2}s`);
    piece.style.setProperty("--spin", `${Math.random() * 360}deg`);
    piece.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 180)}px`);
    burst.append(piece);
  }
  overlay.append(burst);
  setTimeout(() => {
    burst.remove();
    if (!overlay.querySelector(".aws-saa-tracker-burst")) {
      overlay.remove();
      if (celebrationOverlay === overlay) celebrationOverlay = null;
    }
  }, 4500);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DAILY_GOAL_REACHED") {
    celebrateGoal();
    return;
  }

  if (message?.type === "DAILY_STREAK_EXTENDED") {
    const extraTime = celebrationDuration(message.extraSeconds);
    celebrateGoal(
      `🔥 ¡Seguís en racha! +${extraTime} extra hoy`,
      120,
      ["#d7a84a", "#f2c14e", "#2f6851", "#75a77f", "#8bb6ce"],
    );
    return;
  }

  if (message?.type === "CELEBRATE_DAILY_GOAL") {
    celebrateGoal();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "REQUEST_SNAPSHOT") {
    if (extensionContextInvalidated) {
      sendResponse({ ok: false, error: "La extensión se recargó. Recargá esta página del curso." });
      return;
    }
    const snapshot = scrapeCourse("popup refresh");
    if (!snapshot) {
      sendResponse({
        ok: false,
        error: "No encontré el curso SAA-C03 en esta pestaña.",
        diagnostic: lastScanDiagnostic,
      });
      return;
    }
    void (async () => {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: "COURSE_SNAPSHOT", snapshot });
      } catch (error) {
        const wasInvalidated = handleExtensionContextError(error, "popup refresh");
        if (!wasInvalidated) logRuntimeMessageError("No se pudo enviar la lectura solicitada por el popup.", error, "popup refresh");
        response = {
          ok: false,
          error: wasInvalidated
            ? "La extensión se recargó. Recargá esta página del curso y volvé a tocar Actualizar."
            : errorDetails(error).message,
        };
      }

      try {
        sendResponse(response);
      } catch (error) {
        logRuntimeMessageError("No se pudo responder al popup.", error, "popup refresh response");
      }
    })();
    return true;
  }
});

console.info(`${LOG_PREFIX} Content script inyectado.`, pageDetails());

observer = new MutationObserver((records) => {
  if (extensionContextInvalidated) return;
  const sidebarChanged = records.some((record) => {
    if (record.type === "attributes") return isInsideSidebar(record.target);
    return isInsideSidebar(record.target) ||
      [...record.addedNodes, ...record.removedNodes].some(containsSidebar);
  });
  const quizChanged = records.some((record) => {
    if (record.type === "attributes") return isInsideQuiz(record.target);
    return isInsideQuiz(record.target) ||
      [...record.addedNodes, ...record.removedNodes].some(containsQuiz);
  });
  if (sidebarChanged) scheduleSnapshot();
  if (sidebarChanged || quizChanged) syncQuizCompletionState();
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest(COMPLETION_CONTROL_SELECTOR) : null;
  if (!target) return;

  const lectureId = currentLectureId();
  if (lectureId) {
    void (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "COMPLETION_CLICKED", lectureId });
        if (!response?.ok) console.warn(`${LOG_PREFIX} No se pudo registrar el avance solicitado.`, response);
      } catch (error) {
        logRuntimeMessageError("No se pudo registrar el clic de completar lección.", error, "completion button click");
      }
    })();
  }
  scheduleCompletionSync();
}, true);

window.addEventListener("popstate", () => {
  syncQuizCompletionState();
  scheduleSnapshot("popstate navigation");
});
window.addEventListener("hashchange", () => {
  syncQuizCompletionState();
  scheduleSnapshot("hash navigation");
});
window.addEventListener("pageshow", () => {
  syncQuizCompletionState();
  scheduleSnapshot("page show");
});
document.addEventListener("turbo:load", () => {
  syncQuizCompletionState();
  scheduleSnapshot("Turbo navigation");
});
document.addEventListener("turbolinks:load", () => {
  syncQuizCompletionState();
  scheduleSnapshot("Turbolinks navigation");
});
syncQuizCompletionState();
scheduleSnapshot();
