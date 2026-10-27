import { CloudAuthProvider } from "./src/features/cloud/CloudAuthProvider";
import { TvApp } from "./src/App";

export default function App() {
  return <TvApp cloudProvider={CloudAuthProvider} />;
}
