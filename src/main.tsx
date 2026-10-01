import { installAirgap } from './02_Define_The_Rules/airgap.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Before anything else the page does: the global's outbound primitives are held to this machine and frozen
// (02_Define_The_Rules/airgap.ts). The imports above evaluate first, and none of them addresses anything at load
// (10_Network/airgap.test.ts pins every call site in the product); the physics worker installs its own.
installAirgap(globalThis)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
