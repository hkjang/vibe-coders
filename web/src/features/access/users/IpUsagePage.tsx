import { IpsTab } from "./IpsTab";
import { UsersPageShell } from "./UsersPageShell";

/** Independent route chunk: IP readers do not download the account editors. */
export function IpUsagePage() {
  return (
    <UsersPageShell tab="ips" canWrite={false}>
      <IpsTab />
    </UsersPageShell>
  );
}
