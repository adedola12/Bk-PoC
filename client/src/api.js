import axios from "axios";
import { API_BASE } from "./config.js";

const api = axios.create({ baseURL: `${API_BASE}/api` });

export const uploadFiles = (files) => {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  return api.post("/uploads", form).then((res) => res.data);
};

export const fetchTriage = () =>
  api.get("/triage").then((res) => {
    // A misconfigured VITE_API_BASE makes the SPA rewrite answer with HTML —
    // fail loudly instead of letting components crash on a string.
    if (!Array.isArray(res.data)) throw new Error("API base misconfigured — set VITE_API_BASE");
    return res.data;
  });

export const verifyTriage = (id, { confirm, label }) =>
  api.post(`/triage/${id}/verify`, { confirm, label }).then((res) => res.data);

export const verifyAllTriage = () => api.post("/triage/verify-all").then((res) => res.data);

export const previewUrl = (id) => `${API_BASE}/api/triage/${id}/preview`;

export const uploadFromUrl = (url) => api.post("/uploads/url", { url }).then((res) => res.data);

export const extractUpload = (id) => api.post(`/pipeline/${id}/extract`).then((res) => res.data);

// uploadIds scopes both to specific source files; empty/omitted = whole store
export const fetchIprs = (uploadIds = []) =>
  api
    .get("/pipeline/iprs", uploadIds.length ? { params: { uploads: uploadIds.join(",") } } : undefined)
    .then((res) => res.data);

export const runEmission = (uploadIds = []) =>
  api.post("/emit", uploadIds.length ? { uploadIds } : {}).then((res) => res.data);

export const emissionDownloadUrl = (runId, file) => `${API_BASE}/api/emit/download/${runId}/${file}`;

export const fetchReview = () => api.get("/review").then((res) => res.data);
export const resolveReview = (id, body) => api.post(`/review/${id}/resolve`, body).then((res) => res.data);

export const fetchTodos = () => api.get("/todos").then((res) => res.data);
export const todoDone = (id) => api.post(`/todos/${id}/done`).then((res) => res.data);

export const fetchCompare = (category) =>
  api.get("/prices/compare", { params: { category } }).then((res) => res.data);
export const fetchPriceHistory = (sku) => api.get(`/prices/${encodeURIComponent(sku)}`).then((res) => res.data);
export const addManualPrice = (body) => api.post("/prices/manual", body).then((res) => res.data);

export const fetchLatestReport = () => api.get("/reports/latest").then((res) => res.data);

/** Server { error } shape → readable message (ADLM error convention). */
export const errMsg = (err, fallback) => err.response?.data?.error || fallback;

export default api;
