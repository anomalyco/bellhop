import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { DesignSystem } from "./routes/DesignSystem"
import "./styles/theme.css"
import "./styles/components.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Switch>
      <Route path="/_design" component={DesignSystem} />
    </Switch>
  </StrictMode>,
)
