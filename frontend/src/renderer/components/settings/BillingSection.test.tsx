import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";
import type { CloudCpBillingSummary } from "../../lib/cloud-cp/types";
import { CloudCpError } from "../../lib/cloud-cp/errors";
import { BillingSection, formatHours, formatRelative } from "./BillingSection";

const mocks = vi.hoisted(() => ({
	summary: { value: null as unknown },
	client: {
		getBilling: vi.fn(),
		createBillingCheckout: vi.fn(),
		createBillingPortal: vi.fn(),
		resetBillingUsage: vi.fn(),
	},
	openExternal: vi.fn(),
}));

vi.mock("../../hooks/useCloudGate", () => ({ useCloudGate: () => ({ cloudEnabled: true }) }));
vi.mock("../../lib/cloud-session", () => ({ useCloudSession: () => ({ status: "authenticated" }) }));
vi.mock("../../hooks/useCloudCp", () => ({
	useCloudCp: () => ({ client: mocks.client, ready: true, baseUrl: "https://cp.test" }),
}));
vi.mock("../../hooks/useCloudOrg", () => ({ useCloudOrg: () => ({ org: { id: "org-1" } }) }));
vi.mock("../../lib/bridge", () => ({ aoBridge: { app: { openExternal: mocks.openExternal } } }));

const starterLimits = {
	plan: "starter", maxActiveSandboxes: 2, orchestratorSlots: 1, windowHours: 5,
	windowSessionHours: 6, weeklySessionHours: 20, manualResetsPerMonth: 1,
};

function subscribed(overrides: Partial<CloudCpBillingSummary> = {}): CloudCpBillingSummary {
	return {
		enabled: true, exempt: false, plan: "starter", subscriptionStatus: "active", entitled: true,
		currentPeriodEnd: "2026-11-10T09:00:00Z", limits: starterLimits,
		usage: {
			windowUsedMinutes: 252, windowLimitMinutes: 360, windowHours: 5,
			weeklyUsedMinutes: 780, weeklyLimitMinutes: 1200, weeklyResetsAt: "2026-10-12T09:00:00Z",
			manualResetsAllowed: 1, manualResetsUsed: 0, manualResetsRenewAt: "2026-11-10T09:00:00Z",
			activeOrchestrators: 1, activeWorkers: 0,
		},
		plans: [],
		...overrides,
	};
}

function renderSection() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<BillingSection />
		</QueryClientProvider>,
	);
}

describe("BillingSection", () => {
	beforeEach(async () => {
		await appI18n.changeLanguage("en");
		vi.clearAllMocks();
	});

	it("offers the plans priced from Stripe when the org has none, and opens Checkout in the browser", async () => {
		mocks.client.getBilling.mockResolvedValue({
			enabled: true, exempt: false, plan: "free", entitled: false,
			plans: [
				{ name: "starter", id: "price_1", unitAmount: 2000, currency: "usd", interval: "month", limits: starterLimits },
				{ name: "pro", id: "price_2", unitAmount: 4000, currency: "usd", interval: "month", limits: { ...starterLimits, plan: "pro", maxActiveSandboxes: 4, weeklySessionHours: 40 } },
			],
		});
		mocks.client.createBillingCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/cs_1" });
		renderSection();
		expect(await screen.findByText("Choose a plan")).toBeInTheDocument();
		expect(screen.getByText("Starter")).toBeInTheDocument();
		expect(screen.getByText(/\$20\.00 \/ month · 2 sessions · 20 h a week/)).toBeInTheDocument();
		expect(screen.getByText(/\$40\.00 \/ month · 4 sessions · 40 h a week/)).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: "Choose" })[0]);
		await waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith("https://checkout.stripe.test/cs_1"));
		expect(mocks.client.createBillingCheckout).toHaveBeenCalledWith("org-1", "starter");
	});

	it("shows usage against the plan with meters and the sessions in use", async () => {
		mocks.client.getBilling.mockResolvedValue(subscribed());
		renderSection();
		expect(await screen.findByText("Starter")).toBeInTheDocument();
		expect(screen.getByText("5-hour window")).toBeInTheDocument();
		expect(screen.getByText("4.2 of 6 h")).toBeInTheDocument();
		expect(screen.getByText(/^13 of 20 h · resets /)).toBeInTheDocument();
		expect(screen.getByText("Orchestrator 1 of 1 · Workers 0 of 1")).toBeInTheDocument();
		const meters = screen.getAllByRole("meter");
		expect(meters).toHaveLength(2);
		expect(meters[0]).toHaveAttribute("aria-valuenow", "252");
		expect(screen.getByText("1 of 1 left this billing period")).toBeInTheDocument();
	});

	it("confirms before spending a manual reset, then shows the reset week", async () => {
		mocks.client.getBilling.mockResolvedValue(subscribed());
		const after = subscribed();
		after.usage = { ...after.usage!, weeklyUsedMinutes: 0, manualResetsUsed: 1 };
		mocks.client.resetBillingUsage.mockResolvedValue(after);
		renderSection();
		fireEvent.click(await screen.findByRole("button", { name: "Reset now" }));
		expect(mocks.client.resetBillingUsage).not.toHaveBeenCalled();
		expect(screen.getByText("Reset weekly usage?")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		await waitFor(() => expect(mocks.client.resetBillingUsage).toHaveBeenCalledWith("org-1"));
		expect(await screen.findByText(/^0 of 20 h · resets /)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset now" })).toBeDisabled();
	});

	it("explains when only admins may manage billing", async () => {
		mocks.client.getBilling.mockResolvedValue(subscribed());
		mocks.client.createBillingPortal.mockRejectedValue(new CloudCpError("forbidden", { status: 403, code: "forbidden" }));
		renderSection();
		fireEvent.click(await screen.findByRole("button", { name: "Manage billing" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Only organization admins can manage billing.");
		expect(mocks.openExternal).not.toHaveBeenCalled();
	});

	it("says so plainly when billing is off or the org is exempt", async () => {
		mocks.client.getBilling.mockResolvedValue({ enabled: false, exempt: false, plan: "", entitled: false, plans: [] });
		renderSection();
		expect(await screen.findByText("Billing isn't enabled on this server.")).toBeInTheDocument();
	});
});

describe("billing formatting", () => {
	it("formats session-minutes as hours", () => {
		expect(formatHours(252)).toBe("4.2");
		expect(formatHours(360)).toBe("6");
		expect(formatHours(0)).toBe("0");
	});

	it("formats time until a reset", () => {
		const t = appI18n.t.bind(appI18n);
		const now = Date.parse("2026-10-10T12:00:00Z");
		expect(formatRelative("2026-10-10T13:20:00Z", t, now)).toBe("in 1 h 20 m");
		expect(formatRelative("2026-10-10T12:05:00Z", t, now)).toBe("in 5 m");
		expect(formatRelative("2026-10-10T11:00:00Z", t, now)).toBe("now");
	});
});
