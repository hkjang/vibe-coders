package mail

import (
	"fmt"
	"mime"
	"strings"
	"time"
)

// Console paths the mails link to. They are paths of the /app console; the
// administrator's mail.base_url supplies the host.
const (
	pathApprovals = "/app/governance/policies"
	pathMyKeys    = "/app/me"
	pathReports   = "/app/text2sql"
)

// Notification is the content of one event mail before recipients are resolved.
type Notification struct {
	Event   string
	Subject string
	Lines   []string
	// Link is a console path (or absolute URL) appended as "바로 열기".
	Link string
	// SubjectID names what the mail is about (an approval id, an API key id, a
	// report id). It is what the delivery log shows and what RepeatAfter keys on.
	SubjectID string
	// RepeatAfter suppresses a second mail about the same SubjectID to the same
	// recipient within the window. Zero means every occurrence is sent.
	RepeatAfter time.Duration
	// Merged names a bundle when several notifications for one recipient are
	// batched into one mail, e.g. "승인 대기 %d건".
	Merged string
}

// Render turns a notification into the message body, appending the console
// link and a footer that says why the mail arrived.
func (n Notification) Render(config Config) string {
	lines := append([]string{}, n.Lines...)
	if link := n.absoluteLink(config); link != "" {
		lines = append(lines, "", "바로 열기: "+link)
	}
	lines = append(lines, "", "—", "이 메일은 vibe-coders 게이트웨이의 알림 설정에 따라 자동으로 발송되었습니다.")
	return strings.Join(lines, "\n")
}

func (n Notification) absoluteLink(config Config) string {
	if n.Link == "" {
		return ""
	}
	if strings.HasPrefix(n.Link, "http://") || strings.HasPrefix(n.Link, "https://") {
		return n.Link
	}
	if config.BaseURL == "" {
		return ""
	}
	return config.BaseURL + "/" + strings.TrimLeft(n.Link, "/")
}

// merge folds several notifications for one recipient into one so a burst of
// approvals arrives as a single mail rather than a dozen.
func merge(items []Notification) Notification {
	if len(items) == 1 {
		return items[0]
	}
	first := items[0]
	out := Notification{Event: first.Event, Link: first.Link, Subject: first.Subject}
	if first.Merged != "" {
		out.Subject = fmt.Sprintf(first.Merged, len(items))
	}
	for index, item := range items {
		if index > 0 {
			out.Lines = append(out.Lines, "")
		}
		out.Lines = append(out.Lines, item.Lines...)
	}
	return out
}

// ApprovalRequested tells approvers that a request is parked until one of
// them decides. Reason is the policy's public reason, never the prompt.
func ApprovalRequested(approvalID, requester, model, reason string, costKRW float64) Notification {
	who := strings.TrimSpace(requester)
	if who == "" {
		who = "알 수 없는 사용자"
	}
	lines := []string{fmt.Sprintf("%s 님의 요청이 승인을 기다리고 있습니다. 승인 전까지 그 요청은 막혀 있습니다.", who)}
	if model = strings.TrimSpace(model); model != "" {
		lines = append(lines, "모델: "+model)
	}
	if costKRW > 0 {
		lines = append(lines, fmt.Sprintf("예상 비용: %.0f KRW", costKRW))
	}
	if reason = strings.TrimSpace(reason); reason != "" {
		lines = append(lines, "사유: "+reason)
	}
	lines = append(lines, "승인 id: "+approvalID)
	return Notification{
		Event:     EventApprovalRequested,
		Subject:   "[vibe-coders] 승인 대기: " + who + " 님의 요청",
		Lines:     lines,
		Link:      pathApprovals,
		SubjectID: approvalID,
		Merged:    "[vibe-coders] 승인 대기 %d건",
	}
}

// ApprovalDecided tells the requester what was decided so they stop retrying.
func ApprovalDecided(approvalID, status, model string) Notification {
	result := "거절되었습니다. 같은 요청은 계속 막힙니다."
	if status == "approved" {
		result = "승인되었습니다. 요청 헤더에 X-Governance-Approval-ID: " + approvalID + " 를 붙여 다시 보내면 통과합니다."
	}
	lines := []string{"승인 대기 중이던 요청이 " + result}
	if model = strings.TrimSpace(model); model != "" {
		lines = append(lines, "모델: "+model)
	}
	lines = append(lines, "승인 id: "+approvalID)
	return Notification{
		Event:     EventApprovalDecided,
		Subject:   "[vibe-coders] 승인 요청이 처리되었습니다 (" + status + ")",
		Lines:     lines,
		Link:      pathApprovals,
		SubjectID: approvalID,
	}
}

// KeyBlocked tells a key owner their calls have started failing and why, once
// per key per day: the first refusal is the news, the thousandth is not.
func KeyBlocked(keyID, keyName, reason string) Notification {
	label := strings.TrimSpace(keyName)
	if label == "" {
		label = keyID
	}
	return Notification{
		Event:   EventKeyBlocked,
		Subject: "[vibe-coders] API 키 '" + label + "' 호출이 차단되고 있습니다",
		Lines: []string{
			"API 키 '" + label + "' 로 보낸 요청이 게이트웨이에서 거절되기 시작했습니다.",
			"사유: " + strings.TrimSpace(reason),
			"한도가 풀리거나 관리자가 조정할 때까지 같은 키의 요청은 계속 실패합니다.",
		},
		Link:        pathMyKeys,
		SubjectID:   keyID,
		RepeatAfter: 24 * time.Hour,
	}
}

// ReportFailed tells a report's author that the scheduled run did not produce
// anything, once per report per day.
func ReportFailed(reportID, name, reason string) Notification {
	return Notification{
		Event:   EventReportFailed,
		Subject: "[vibe-coders] 예약 리포트 '" + name + "' 실행 실패",
		Lines: []string{
			"예약된 Text2SQL 리포트 '" + name + "' 이(가) 이번 실행에서 결과를 만들지 못했습니다.",
			"사유: " + strings.TrimSpace(reason),
			"고치기 전까지 다음 예약 시각에도 같은 이유로 실패합니다.",
		},
		Link:        pathReports,
		SubjectID:   reportID,
		RepeatAfter: 24 * time.Hour,
	}
}

// TestMessage proves the relay works from the settings screen.
func TestMessage() Notification {
	return Notification{
		Event:   EventTest,
		Subject: "[vibe-coders] SMTP 발송 테스트",
		Lines:   []string{"vibe-coders 관리자 화면에서 보낸 테스트 메일입니다.", "이 메일을 받았다면 SMTP 설정이 정상입니다."},
		Link:    "/app/system/settings?tab=mail",
	}
}

// compose builds a MIME message. Korean subjects and names are encoded so
// relays and clients that predate UTF-8 headers still show them correctly.
func compose(config Config, message Message, now time.Time) string {
	var builder strings.Builder
	builder.WriteString("From: " + encodeAddress(config.Address()) + "\r\n")
	builder.WriteString("To: " + strings.TrimSpace(message.To) + "\r\n")
	builder.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", headerText(message.Subject)) + "\r\n")
	builder.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	builder.WriteString("MIME-Version: 1.0\r\n")
	builder.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	builder.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	builder.WriteString("Auto-Submitted: auto-generated\r\n")
	builder.WriteString("X-Vibe-Coders-Notification: 1\r\n")
	builder.WriteString("\r\n")
	builder.WriteString(normalizeBody(message.Body))
	return builder.String()
}

// headerText strips line breaks so a subject can never inject a header.
func headerText(value string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " ")), " ")
}

func encodeAddress(address string) string {
	open := strings.LastIndex(address, "<")
	if open <= 0 {
		return address
	}
	return mime.QEncoding.Encode("utf-8", headerText(address[:open])) + " " + address[open:]
}

// normalizeBody uses CRLF line endings. Dot-stuffing (so a line of text can
// never terminate the DATA command early) is done by the DATA writer the
// standard library hands out; doing it here as well would double the dots.
func normalizeBody(body string) string {
	body = strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")
	if !strings.HasSuffix(body, "\r\n") {
		body += "\r\n"
	}
	return body
}
