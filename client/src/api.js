import axios from "axios";
import { API_BASE } from "./config.js";

const api = axios.create({ baseURL: `${API_BASE}/api` });

export const uploadFiles = (files) => {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  return api.post("/uploads", form).then((res) => res.data);
};

export const fetchTriage = () => api.get("/triage").then((res) => res.data);

export const verifyTriage = (id, { confirm, label }) =>
  api.post(`/triage/${id}/verify`, { confirm, label }).then((res) => res.data);

export const previewUrl = (id) => `${API_BASE}/api/triage/${id}/preview`;

/** Server { error } shape → readable message (ADLM error convention). */
export const errMsg = (err, fallback) => err.response?.data?.error || fallback;

export default api;
