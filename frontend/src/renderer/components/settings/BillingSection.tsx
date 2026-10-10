import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useCloudCp } from "../../hooks/useCloudCp";
import { useCloudGate } from "../../hooks/useCloudGate";
import { useCloudOrg } from "../../hooks/useCloudOrg";
import { aoBridge } from "../../lib/bridge";
import { CloudCpError } from "../../lib/cloud-cp/errors";
import type { CloudCpBillingSummary, CloudCpBillingUsage, CloudCpPlanOffer } from "../../lib/cloud-cp/types";
import { useCloudSession } from "../../lib/cloud-session";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export const cloudBillingQueryKey = ["cloud-billing"] as const;

/** After a Checkout or Portal opens, poll briefly so the new plan shows without a manual refresh. */
const POLL_AFTER_EXTERNAL_MS = 5_000;
const POLL_WINDOW_MS = 3 * 60_000;

/**
 * The org's AO Cloud plan, its usage against the plan, and the actions an admin
 * takes on it. Payment itself happens on Stripe's pages in the system browser.
 */
export function BillingSection({ titleHidden }: { titleHidden?: boolean }) {
	const { cloudEnabled } = useCloudGate();
	if (!cloudEnabled) return null;
	return <BillingSectionInner titleHidden={titleHidden} />;
}

function BillingSectionInner({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const { status } = useCloudSession();
	const { client, ready } = useCloudCp();
	const { org } = useCloudOrg();
	const queryClient = useQueryClient();
	const orgId = org?.id ?? "";
	const [pollUntil, setPollUntil] = useState(0);
	const billing = useQuery({
		queryKey: [...cloudBillingQueryKey, orgId],
		enabled: ready && orgId !== "",
		queryFn: ({ signal }) => client.getBilling(orgId, { signal }),
		refetchOnWindowFocus: true,
		refetchInterval: () => (Date.now() < pollUntil ? POLL_AFTER_EXTERNAL_MS : false),
	});
	const [pending, setPending] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [confirmReset, setConfirmReset] = useState(false);

	const title = t("settings.billing.title");
	if (status !== "authenticated") {
		return (
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden}>
				<p className="px-3 text-xs leading-relaxed text-muted-foreground">{t("settings.billing.signIn")}</p>
			</SettingsSection>
		);
	}
	if (billing.isPending) {
		return (
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden}>
				<p className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
					<Loader2 className="size-icon-sm animate-spin" aria-hidden="true" />
					{t("settings.billing.loading")}
				</p>
			</SettingsSection>
		);
	}
	if (billing.isError || !billing.data) {
		return (
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden}>
				<div className="flex items-center gap-2 px-3 text-xs text-destructive">
					{t("settings.billing.loadFailed")}
					<Button variant="ghost" size="sm" onClick={() => void billing.refetch()}>{t("settings.billing.retry")}</Button>
				</div>
			</SettingsSection>
		);
	}
	const summary = billing.data;

	const runAction = async (name: string, action: () => Promise<void>) => {
		setPending(name);
		setActionError(null);
		try {
			await action();
		} catch (error) {
			setActionError(billingActionError(error, t));
		} finally {
			setPending(null);
		}
	};
	const openExternal = (name: string, link: () => Promise<{ url: string }>) =>
		runAction(name, async () => {
			const { url } = await link();
			await aoBridge.app.openExternal(url);
			setPollUntil(Date.now() + POLL_WINDOW_MS);
		});
	const reset = () =>
		runAction("reset", async () => {
			const next = await client.resetBillingUsage(orgId);
			queryClient.setQueryData([...cloudBillingQueryKey, orgId], { ...summary, ...next, plans: summary.plans });
			setConfirmReset(false);
		});

	if (!summary.enabled) {
		return (
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden}>
				<p className="px-3 text-xs leading-relaxed text-muted-foreground">{t("settings.billing.disabled")}</p>
			</SettingsSection>
		);
	}
	if (summary.exempt) {
		return (
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden}>
				<p className="px-3 text-xs leading-relaxed text-muted-foreground">{t("settings.billing.exempt")}</p>
			</SettingsSection>
		);
	}

	const error = actionError ? <p role="alert" className="px-3 text-xs text-destructive">{actionError}</p> : null;

	if (!summary.entitled) {
		const lapsed = summary.subscriptionStatus === "past_due" || summary.subscriptionStatus === "unpaid";
		return (
			<>
				{lapsed ? (
					<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden} grouped>
						<SettingsRow label={planName(summary.plan, t)} description={t("settings.billing.paymentFailed")}>
							<Button size="sm" disabled={pending !== null} onClick={() => void openExternal("portal", () => client.createBillingPortal(orgId))}>
								{pending === "portal" ? <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" /> : <ExternalLink className="size-icon-sm" aria-hidden="true" />}
								{t("settings.billing.updatePayment")}
							</Button>
						</SettingsRow>
					</SettingsSection>
				) : null}
				<SettingsSection title={t("settings.billing.choosePlan")} sectionId={lapsed ? undefined : "billing"} titleHidden={titleHidden && !lapsed} grouped>
					{(summary.plans ?? []).map((offer) => (
						<SettingsRow key={offer.name} label={planName(offer.name, t)} description={offerDetail(offer, t)}>
							<Button size="sm" variant="secondary" disabled={pending !== null}
								onClick={() => void openExternal(`checkout:${offer.name}`, () => client.createBillingCheckout(orgId, offer.name))}>
								{pending === `checkout:${offer.name}` ? <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" /> : null}
								{t("settings.billing.choose")}
							</Button>
						</SettingsRow>
					))}
				</SettingsSection>
				{error}
			</>
		);
	}

	const limits = summary.limits;
	const usage = summary.usage;
	const resetsLeft = usage ? Math.max(0, usage.manualResetsAllowed - usage.manualResetsUsed) : 0;
	return (
		<>
			<SettingsSection title={title} sectionId="billing" titleHidden={titleHidden} grouped>
				<SettingsRow
					label={planName(summary.plan, t)}
					description={summary.subscriptionStatus === "past_due" ? t("settings.billing.paymentFailed") : planRenewal(summary, t)}
				>
					<Button size="sm" variant="secondary" disabled={pending !== null} onClick={() => void openExternal("portal", () => client.createBillingPortal(orgId))}>
						{pending === "portal" ? <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" /> : <ExternalLink className="size-icon-sm" aria-hidden="true" />}
						{t("settings.billing.manage")}
					</Button>
				</SettingsRow>
			</SettingsSection>
			{limits && usage ? (
				<SettingsSection title={t("settings.billing.usage")} grouped>
					<UsageRow
						label={t("settings.billing.window", { hours: usage.windowHours })}
						used={usage.windowUsedMinutes}
						limit={usage.windowLimitMinutes}
						resetsAt={usage.windowResetsAt}
						t={t}
					/>
					<UsageRow
						label={t("settings.billing.weekly")}
						used={usage.weeklyUsedMinutes}
						limit={usage.weeklyLimitMinutes}
						resetsAt={usage.weeklyResetsAt}
						absoluteReset
						t={t}
					/>
					<SettingsRow label={t("settings.billing.sessions")} description={sessionsDetail(usage, limits.orchestratorSlots, limits.maxActiveSandboxes, t)}>
						<span />
					</SettingsRow>
					<SettingsRow
						label={t("settings.billing.reset")}
						description={resetsLeft > 0
							? t("settings.billing.resetDetail", { left: resetsLeft, allowed: usage.manualResetsAllowed })
							: t("settings.billing.resetNoneLeft", { date: formatDate(usage.manualResetsRenewAt) })}
					>
						<Button size="sm" variant="secondary" disabled={resetsLeft === 0 || pending !== null} onClick={() => setConfirmReset(true)}>
							{t("settings.billing.resetNow")}
						</Button>
					</SettingsRow>
				</SettingsSection>
			) : null}
			{error}
			<Dialog open={confirmReset} onOpenChange={(open) => { if (pending !== "reset") setConfirmReset(open); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("settings.billing.resetConfirmTitle")}</DialogTitle>
						<DialogDescription>{t("settings.billing.resetConfirmBody")}</DialogDescription>
					</DialogHeader>
					{actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
					<DialogFooter>
						<Button variant="ghost" size="sm" disabled={pending === "reset"} onClick={() => setConfirmReset(false)}>{t("settings.billing.cancel")}</Button>
						<Button size="sm" disabled={pending === "reset"} onClick={() => void reset()}>
							{pending === "reset" ? <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" /> : null}
							{t("settings.billing.resetConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function UsageRow({ label, used, limit, resetsAt, absoluteReset, t }: {
	label: string;
	used: number;
	limit: number;
	resetsAt?: string;
	absoluteReset?: boolean;
	t: TFunction;
}) {
	const fraction = limit > 0 ? Math.min(1, used / limit) : 0;
	const values = { used: formatHours(used), limit: formatHours(limit) };
	const description = resetsAt
		? t("settings.billing.usageDetail", { ...values, resets: absoluteReset ? formatDate(resetsAt) : formatRelative(resetsAt, t) })
		: t("settings.billing.usageDetailNoReset", values);
	return (
		<SettingsRow label={label} description={description}>
			<div
				role="meter"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={limit}
				aria-valuenow={Math.min(used, limit)}
				className="h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]"
			>
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-(--duration-normal)",
						fraction >= 1 ? "bg-destructive" : fraction >= 0.8 ? "bg-[var(--color-status-in-review)]" : "bg-[var(--color-accent)]",
					)}
					style={{ width: `${fraction * 100}%` }}
				/>
			</div>
		</SettingsRow>
	);
}

function planName(plan: string, t: TFunction): string {
	if (!plan || plan === "free") return t("settings.billing.noPlan");
	return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function offerDetail(offer: CloudCpPlanOffer, t: TFunction): string | undefined {
	const parts: string[] = [];
	if (offer.unitAmount !== undefined && offer.currency) {
		parts.push(t("settings.billing.price", { price: formatMoney(offer.unitAmount, offer.currency), interval: intervalLabel(offer.interval, t) }));
	}
	if (offer.limits) {
		parts.push(t("settings.billing.planSessions", { count: offer.limits.maxActiveSandboxes }));
		parts.push(t("settings.billing.planWeekly", { hours: offer.limits.weeklySessionHours }));
	}
	return parts.length ? parts.join(" · ") : undefined;
}

function planRenewal(summary: CloudCpBillingSummary, t: TFunction): string | undefined {
	if (!summary.currentPeriodEnd) return undefined;
	return t("settings.billing.renews", { date: formatDate(summary.currentPeriodEnd) });
}

function sessionsDetail(usage: CloudCpBillingUsage, orchestratorSlots: number, maxActive: number, t: TFunction): string {
	if (orchestratorSlots > 0) {
		return t("settings.billing.sessionsDetail", {
			orchestrators: usage.activeOrchestrators,
			orchestratorSlots,
			workers: usage.activeWorkers,
			workerSlots: maxActive - orchestratorSlots,
		});
	}
	return t("settings.billing.sessionsDetailShared", { used: usage.activeOrchestrators + usage.activeWorkers, limit: maxActive });
}

function intervalLabel(interval: string | undefined, t: TFunction): string {
	return interval === "year" ? t("settings.billing.intervalYear") : t("settings.billing.intervalMonth");
}

function formatMoney(minorUnits: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minorUnits / 100);
	} catch {
		return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}

/** Session-minutes as hours with at most one decimal: 252 → "4.2". */
export function formatHours(minutes: number): string {
	const hours = Math.round((minutes / 60) * 10) / 10;
	return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatDate(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Time until `iso` as "in 1 h 20 m" / "in 5 m" / "now". */
export function formatRelative(iso: string, t: TFunction, now = Date.now()): string {
	const ms = new Date(iso).getTime() - now;
	if (!Number.isFinite(ms) || ms <= 0) return t("settings.billing.resetsNow");
	const totalMinutes = Math.ceil(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return t("settings.billing.inMinutes", { minutes });
	return t("settings.billing.inHoursMinutes", { hours, minutes });
}

function billingActionError(error: unknown, t: TFunction): string {
	if (error instanceof CloudCpError) {
		if (error.status === 403) return t("settings.billing.adminOnly");
		if (error.code === "ALREADY_SUBSCRIBED") return t("settings.billing.alreadySubscribed");
		if (error.code === "NO_RESETS_LEFT") return t("settings.billing.noResetsLeft");
	}
	return t("settings.billing.actionFailed");
}
