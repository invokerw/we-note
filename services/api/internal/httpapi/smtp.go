package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/store"
)

type Mailer interface {
	Send(context.Context, store.SMTPConfig, string, string, string) error
}
type SMTPMailer struct{}

func (SMTPMailer) Send(ctx context.Context, c store.SMTPConfig, to, subject, body string) error {
	if !validEmail(c.From) || !validEmail(to) || c.Host == "" || strings.ContainsAny(c.FromName, "\r\n") || (c.ReplyTo != "" && !validEmail(c.ReplyTo)) {
		return errors.New("请检查 SMTP 主机和邮件地址")
	}
	dial := net.Dialer{Timeout: 8 * time.Second}
	addr := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	conn, err := dial.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	tlsConfig := &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12}
	if c.Security == "tls" {
		conn = tls.Client(conn, tlsConfig)
	}
	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		return err
	}
	defer client.Close()
	switch c.Security {
	case "starttls":
		if err = client.StartTLS(tlsConfig); err != nil {
			return err
		}
	case "tls":
	case "plain":
		if c.Username != "" || c.Password != "" {
			return errors.New("SMTP 认证需要 TLS")
		}
	default:
		return errors.New("未知 SMTP 安全方式")
	}
	if c.Username != "" {
		if err = client.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return err
		}
	}
	if err = client.Mail(c.From); err != nil {
		return err
	}
	if err = client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	from := mail.Address{Name: c.FromName, Address: c.From}
	reply := ""
	if c.ReplyTo != "" {
		reply = "Reply-To: " + c.ReplyTo + "\r\n"
	}
	_, err = fmt.Fprintf(w, "From: %s\r\nTo: %s\r\n%sSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", from.String(), to, reply, mime.QEncoding.Encode("UTF-8", subject), body)
	if err != nil {
		return err
	}
	return w.Close()
}
