package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func sign(payload []byte, secret string, at time.Time) string {
	timestamp := fmt.Sprint(at.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(payload)
	return "t=" + timestamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyWebhook(t *testing.T) {
	payload := []byte(`{"id":"evt_1","type":"customer.subscription.updated","data":{"object":{"id":"sub_1","object":"subscription","customer":"cus_1"}}}`)
	now := time.Unix(1_800_000_000, 0)
	event, err := VerifyWebhook(payload, sign(payload, "whsec_test", now), "whsec_test", now)
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "evt_1" || event.Data.Object.ID != "sub_1" || event.Data.Object.Customer != "cus_1" {
		t.Fatalf("event = %+v", event)
	}
	for name, header := range map[string]string{
		"wrong secret":  sign(payload, "whsec_other", now),
		"too old":       sign(payload, "whsec_test", now.Add(-10*time.Minute)),
		"no signature":  "t=" + fmt.Sprint(now.Unix()),
		"garbage":       "nonsense",
		"tampered body": sign([]byte(`{"id":"evt_2"}`), "whsec_test", now),
	} {
		if _, err := VerifyWebhook(payload, header, "whsec_test", now); !errors.Is(err, ErrInvalidSignature) {
			t.Errorf("%s: err = %v, want ErrInvalidSignature", name, err)
		}
	}
	if _, err := VerifyWebhook(payload, sign(payload, "", now), "", now); !errors.Is(err, ErrInvalidSignature) {
		t.Error("an empty endpoint secret must reject every webhook")
	}
}

func TestGetSubscriptionReadsLimitsAndPeriodFromItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, _, _ := r.BasicAuth(); user != "rk_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/v1/subscriptions/sub_1" || r.URL.Query().Get("expand[]") != "items.data.price.product" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, `{"id":"sub_1","customer":"cus_1","status":"active","metadata":{"ao_org_id":"org-1"},
			"items":{"data":[{"current_period_start":1800000000,"current_period_end":1802592000,
			"price":{"product":{"metadata":{"ao_plan":"pro","ao_max_active_sandboxes":"4","ao_orchestrator_slots":"1",
			"ao_window_hours":"5","ao_window_session_hours":"12","ao_weekly_session_hours":"40","ao_manual_resets_per_month":"1"}}}}]}}`)
	}))
	defer server.Close()
	subscription, err := NewClient("rk_test", server.URL).GetSubscription(context.Background(), "sub_1")
	if err != nil {
		t.Fatal(err)
	}
	if subscription.Status != "active" || subscription.OrgID != "org-1" || subscription.Limits == nil ||
		subscription.Limits.Plan != "pro" || subscription.Limits.WorkerSlots() != 3 ||
		subscription.PeriodStart == nil || subscription.PeriodStart.Unix() != 1800000000 {
		t.Fatalf("subscription = %+v limits=%+v err=%v", subscription, subscription.Limits, subscription.LimitsErr)
	}
}

func TestCreateCheckoutSessionSendsSubscriptionForm(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.PostForm
		_, _ = io.WriteString(w, `{"url":"https://checkout.stripe.com/c/pay/cs_test"}`)
	}))
	defer server.Close()
	link, err := NewClient("rk_test", server.URL).CreateCheckoutSession(context.Background(), CheckoutRequest{
		OrgID: "org-1", CustomerID: "cus_1", PriceID: "price_pro", SuccessURL: "https://a/ok", CancelURL: "https://a/no",
	})
	if err != nil || !strings.HasPrefix(link, "https://checkout.stripe.com/") {
		t.Fatalf("link = %q err = %v", link, err)
	}
	for key, want := range map[string]string{
		"mode": "subscription", "customer": "cus_1", "client_reference_id": "org-1",
		"line_items[0][price]": "price_pro", "subscription_data[metadata][ao_org_id]": "org-1",
	} {
		if form.Get(key) != want {
			t.Errorf("%s = %q, want %q", key, form.Get(key), want)
		}
	}
}

func TestAPIErrorsSurfaceStripeMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","code":"resource_missing","message":"No such price"}}`)
	}))
	defer server.Close()
	_, err := NewClient("rk_test", server.URL).CreatePortalSession(context.Background(), "cus_1", "")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "resource_missing" || apiErr.Status != 400 {
		t.Fatalf("err = %v", err)
	}
}
