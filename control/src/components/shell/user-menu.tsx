"use client";

import { useRouter } from "next/navigation";
import { LogOut, Settings, User as UserIcon, Command, Server } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/dropdown";
import { api } from "@/lib/client/api";
import { ThemeToggle } from "./theme-toggle";
import { openCommandPalette } from "./command-palette";

export function UserMenu({ user, teamSlug }: { user: { name: string; email: string; avatar: string | null; isPlatformOwner?: boolean }; teamSlug?: string }) {
  const router = useRouter();
  return (
    <Dropdown
      align="end"
      width={260}
      trigger={() => (
        <button className="rounded-full ring-offset-2 ring-offset-bg transition hover:ring-2 hover:ring-border-strong" aria-label="Account menu" data-testid="user-menu">
          <Avatar name={user.name} src={user.avatar} size={30} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 py-2">
            <p className="truncate text-[13px] font-medium text-fg">{user.name}</p>
            <p className="truncate text-[12px] text-muted">{user.email}</p>
          </div>
          <DropdownSeparator />
          <DropdownItem href="/account" icon={<UserIcon className="h-3.5 w-3.5" />} onClick={close}>
            Account settings
          </DropdownItem>
          {teamSlug && (
            <DropdownItem href={`/${teamSlug}/settings`} icon={<Settings className="h-3.5 w-3.5" />} onClick={close}>
              Team settings
            </DropdownItem>
          )}
          {user.isPlatformOwner && (
            <DropdownItem href="/settings" icon={<Server className="h-3.5 w-3.5" />} onClick={close}>
              Platform settings
            </DropdownItem>
          )}
          <DropdownItem
            icon={<Command className="h-3.5 w-3.5" />}
            onClick={() => {
              close();
              openCommandPalette();
            }}
          >
            Command menu <span className="kbd ml-auto">Ctrl K</span>
          </DropdownItem>
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[13px] text-muted">
            Theme
            <ThemeToggle />
          </div>
          <DropdownSeparator />
          <DropdownItem
            icon={<LogOut className="h-3.5 w-3.5" />}
            onClick={async () => {
              close();
              await api("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
              router.push("/login");
              router.refresh();
            }}
          >
            Log out
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}
