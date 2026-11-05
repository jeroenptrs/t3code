import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FactoryPage } from "../components/factories/FactoryPage";

function FactoryRouteView() {
  const { environmentId, factoryId } = Route.useParams();
  return (
    <FactoryPage
      key={`${environmentId}\n${factoryId}`}
      environmentId={EnvironmentId.make(environmentId)}
      factoryId={factoryId}
    />
  );
}

export const Route = createFileRoute("/_chat/factories/$environmentId/$factoryId")({
  component: FactoryRouteView,
});
