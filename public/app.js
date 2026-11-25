const collectForm = document.querySelector("#collect");
const draftForm = document.querySelector("#draft");
const status = document.querySelector("#status");
const sections = {
  disks: "VM disks (JSON)",
  layerExamples: "Layer examples",
  departments: "Departments",
  trainings: "Training sessions",
  integrations: "Integrations",
  mobile: "Mobile forms",
  certificates: "Certificates",
  tickets: "Tickets by level (JSON)",
  nextSteps: "Next steps",
};
const numeric = { users: "Registered users", avgAccessesPerMonth: "Average monthly accesses", layers: "Layers" };
let collected;

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response;
}

function input(label, name, value, kind = "text") {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const field = document.createElement(kind === "textarea" ? "textarea" : "input");
  if (kind !== "textarea") field.type = kind;
  if (kind === "checkbox") field.checked = value;
  else field.value = value;
  if (kind === "number") {
    field.min = "0";
    field.required = true;
  }
  field.name = name;
  wrapper.append(field);
  return wrapper;
}

function showDraft(result) {
  const { report, sources, warnings, details } = result;
  const fields = document.querySelector("#fields");
  const list = document.querySelector("#sources");
  list.replaceChildren(...[...sources.map((s) => `${s.label}: ${s.ok ? `available (${s.ms} ms)` : s.error ?? "unavailable"}`), ...warnings].map((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    return li;
  }));
  fields.replaceChildren(input("Contract number", "contract", report.contract));
  for (const [key, label] of Object.entries(numeric)) fields.append(input(label, key, report[key], "number"));
  for (const [key, label] of Object.entries(sections)) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = label;
    const data = key === "disks" || key === "tickets" ? JSON.stringify(report[key], null, 2) : report[key].join("\n");
    group.append(
      legend,
      input("Include in document", `include-${key}`, key === "nextSteps" || !report.hidden.includes(key), "checkbox"),
      input(key === "disks" || key === "tickets" ? "Data" : "One entry per line", key, data, "textarea"),
      input("Section note", `note-${key}`, report.notes[key] ?? ""),
    );
    if (key === "integrations") {
      for (const suggestion of details.genericIntegrations.filter((item) => !report.integrations.includes(item))) {
        const option = input(`Add suggested integration: ${suggestion}`, "integration-suggestion", false, "checkbox");
        option.querySelector("input").value = suggestion;
        group.append(option);
      }
    }
    fields.append(group);
  }
  document.querySelector("#review").hidden = false;
}

async function updateHistory() {
  const { reports } = await (await request("/api/history")).json();
  const list = document.querySelector("#history");
  list.replaceChildren();
  if (!reports.length) {
    const li = document.createElement("li");
    li.textContent = "No reports generated yet.";
    list.append(li);
  }
  for (const report of reports) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/api/history/reports/${report.id}/docx`;
    link.textContent = report.file_name;
    li.append(link);
    list.append(li);
  }
}

collectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = collectForm.querySelector("button");
  button.disabled = true;
  status.textContent = "Collecting...";
  try {
    const { city, start, end, simulate } = Object.fromEntries(new FormData(collectForm));
    const response = await request("/api/collect", { city, start, end, simulate: simulate ? { [simulate]: "fail" } : undefined });
    collected = await response.json();
    showDraft(collected);
    status.textContent = "Review the draft before downloading.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

draftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = draftForm.querySelector("button");
  button.disabled = true;
  try {
    const data = new FormData(draftForm);
    const report = structuredClone(collected.report);
    report.contract = data.get("contract").trim();
    for (const key of Object.keys(numeric)) report[key] = Number(data.get(key));
    report.hidden = [];
    report.notes = {};
    for (const key of Object.keys(sections)) {
      const value = data.get(key);
      try {
        report[key] = key === "disks" || key === "tickets" ? JSON.parse(value) : value.split("\n").map((line) => line.trim()).filter(Boolean);
      } catch {
        throw new Error(`Invalid JSON in ${sections[key]}.`);
      }
      if (!data.has(`include-${key}`)) report.hidden.push(key);
      const note = data.get(`note-${key}`).trim();
      if (note) report.notes[key] = note;
    }
    const response = await request("/api/docx", {
      report: { ...report, integrations: [...new Set([...report.integrations, ...data.getAll("integration-suggestion")])] },
      suggestedIntegrations: collected.details.suggestedIntegrations,
      edited: data.has("integration-suggestion") || JSON.stringify(report) !== JSON.stringify(collected.report),
    });
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "Contract Summary.docx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Report downloaded.";
    await updateHistory();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function init() {
  const [cities, period] = await Promise.all(["/api/cities", "/api/default-period"].map(async (path) => (await request(path)).json()));
  for (const city of cities) collectForm.elements.city.add(new Option(city.name, city.id));
  collectForm.elements.start.value = period.start;
  collectForm.elements.end.value = period.end;
  document.querySelector("#simulate-field").hidden = !period.faultInjection;
  await updateHistory();
}
init().catch((error) => { status.textContent = error.message; });
