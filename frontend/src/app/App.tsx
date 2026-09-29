import { AppRoutes } from "./AppRoutes";
import { MaxLaunchProvider } from "./MaxLaunchProvider";

export default function App() {
  return (
    <MaxLaunchProvider>
      <AppRoutes />
    </MaxLaunchProvider>
  );
}
