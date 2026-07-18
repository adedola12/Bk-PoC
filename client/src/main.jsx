import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import App from "./App.jsx";
import Upload from "./pages/Upload.jsx";
import TriageVerify from "./pages/TriageVerify.jsx";
import "./index.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/upload" replace /> },
      { path: "upload", element: <Upload /> },
      { path: "triage", element: <TriageVerify /> },
      { path: "*", element: <Navigate to="/upload" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
