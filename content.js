const COURSE_ID = "aws-saa-c03";
const PLATFORM_COURSE_ID = "1820301";
const LOG_PREFIX = "[AWS SAA Tracker]";
const COMPLETION_CONTROL_SELECTOR = "#lecture_complete_button, #lecture_content_complete_button";
let updateTimer;
let lastScanLogKey = "";
let lastScanDiagnostic = null;

function pageDetails() {
  return {
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    readyState: document.readyState,
  };
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

function sendSnapshot(source = "automatic sync") {
  const snapshot = scrapeCourse(source);
  if (!snapshot) return;
  chrome.runtime.sendMessage({ type: "COURSE_SNAPSHOT", snapshot })
    .then((response) => {
      if (!response?.ok) console.error(`${LOG_PREFIX} El service worker rechazó el snapshot.`, response);
    })
    .catch((error) => console.error(`${LOG_PREFIX} No se pudo enviar el snapshot al service worker.`, error));
}

function scheduleSnapshot(source = "sidebar mutation") {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => sendSnapshot(source), 350);
}

function scheduleCompletionSync() {
  console.info(`${LOG_PREFIX} Se pulsó el control de completar lección; voy a volver a leer el sidebar.`, pageDetails());
  [0, 500, 1500, 3500].forEach((delay) => {
    setTimeout(() => sendSnapshot(`completion action retry ${delay}ms`), delay);
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

function celebrateGoal() {
  if (document.querySelector(".aws-saa-tracker-celebration")) return;
  const style = document.createElement("style");
  style.textContent = `
    .aws-saa-tracker-celebration{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;font-family:system-ui,sans-serif}
    .aws-saa-tracker-banner{position:absolute;top:24px;left:50%;transform:translateX(-50%);padding:14px 22px;border-radius:999px;background:#142b40;color:white;font-size:16px;font-weight:700;box-shadow:0 12px 36px #15283a66;animation:aws-saa-banner-in .45s ease-out both}
    .aws-saa-tracker-piece{position:absolute;top:-18px;width:9px;height:14px;border-radius:3px;animation:aws-saa-fall var(--fall-time) linear var(--delay) forwards;left:var(--left);background:var(--color);transform:rotate(var(--spin))}
    @keyframes aws-saa-fall{to{top:110vh;transform:translateX(var(--drift)) rotate(calc(var(--spin) + 720deg));opacity:.8}}
    @keyframes aws-saa-banner-in{from{opacity:0;top:0}to{opacity:1;top:24px}}
    @media(prefers-reduced-motion:reduce){.aws-saa-tracker-piece{animation-duration:1ms!important}.aws-saa-tracker-banner{animation:none}}
  `;
  const overlay = document.createElement("div");
  overlay.className = "aws-saa-tracker-celebration";
  const banner = document.createElement("div");
  banner.className = "aws-saa-tracker-banner";
  banner.textContent = "🎉 ¡Meta diaria cumplida!";
  overlay.append(style, banner);

  const colors = ["#3f6d8c", "#527d99", "#18344e", "#8bb6ce", "#d7a84a"];
  for (let i = 0; i < 72; i += 1) {
    const piece = document.createElement("i");
    piece.className = "aws-saa-tracker-piece";
    piece.style.setProperty("--left", `${Math.random() * 100}%`);
    piece.style.setProperty("--color", colors[i % colors.length]);
    piece.style.setProperty("--delay", `${Math.random() * 1.1}s`);
    piece.style.setProperty("--fall-time", `${2.4 + Math.random() * 1.2}s`);
    piece.style.setProperty("--spin", `${Math.random() * 360}deg`);
    piece.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 180)}px`);
    overlay.append(piece);
  }
  document.documentElement.append(overlay);
  setTimeout(() => overlay.remove(), 4500);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DAILY_GOAL_REACHED") {
    celebrateGoal();
    return;
  }

  if (message?.type === "CELEBRATE_DAILY_GOAL") {
    celebrateGoal();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "REQUEST_SNAPSHOT") {
    const snapshot = scrapeCourse("popup refresh");
    if (!snapshot) {
      sendResponse({
        ok: false,
        error: "No encontré el curso SAA-C03 en esta pestaña.",
        diagnostic: lastScanDiagnostic,
      });
      return;
    }
    chrome.runtime.sendMessage({ type: "COURSE_SNAPSHOT", snapshot })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

console.info(`${LOG_PREFIX} Content script inyectado.`, pageDetails());

const observer = new MutationObserver((records) => {
  const relevant = records.some((record) => {
    if (record.type === "attributes") return isInsideSidebar(record.target);
    return isInsideSidebar(record.target) ||
      [...record.addedNodes, ...record.removedNodes].some(containsSidebar);
  });
  if (relevant) scheduleSnapshot();
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest(COMPLETION_CONTROL_SELECTOR) : null;
  if (target) scheduleCompletionSync();
}, true);

window.addEventListener("popstate", () => scheduleSnapshot("popstate navigation"));
window.addEventListener("hashchange", () => scheduleSnapshot("hash navigation"));
window.addEventListener("pageshow", () => scheduleSnapshot("page show"));
document.addEventListener("turbo:load", () => scheduleSnapshot("Turbo navigation"));
document.addEventListener("turbolinks:load", () => scheduleSnapshot("Turbolinks navigation"));
scheduleSnapshot();
