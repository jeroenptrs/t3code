import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FactoryPage } from "../components/factories/FactoryPage";
import { validateFactoryPageSearch } from "../components/factories/FactoryPage.logic";

function FactoryRouteView() {
  const { environmentId, factoryId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <FactoryPage
      key={`${environmentId}\n${factoryId}`}
      environmentId={EnvironmentId.make(environmentId)}
      factoryId={factoryId}
      search={search}
    />
  );
}

export const Route = createFileRoute("/_chat/factories/$environmentId/$factoryId")({
  validateSearch: validateFactoryPageSearch,
  component: FactoryRouteView,
});
