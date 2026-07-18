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

export const previewUrl = (id) => `${API_BASE}/api/triage/${id}/preview`;

/** Server { error } shape → readable message (ADLM error convention). */
export const errMsg = (err, fallback) => err.response?.data?.error || fallback;

export default api;
