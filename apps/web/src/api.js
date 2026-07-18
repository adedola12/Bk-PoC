import axios from "axios";

const api = axios.create({ baseURL: "/api" });

export const uploadFiles = (files) => {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  return api.post("/uploads", form).then((res) => res.data);
};

export const fetchTriage = () => api.get("/triage").then((res) => res.data);

export const verifyTriage = (id, { confirm, label }) =>
  api.post(`/triage/${id}/verify`, { confirm, label }).then((res) => res.data);

export default api;
