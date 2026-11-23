package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/httpapi"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func main() {
	address := flag.String("addr", ":8080", "HTTP listen address")
	databasePath := flag.String("db", "./data/wenote.db", "SQLite database path")
	blobRoot := flag.String("blobs", "./data/storage", "Local Blob storage root")
	s3Bucket := flag.String("s3-bucket", "", "S3 bucket (default uses local storage)")
	s3Endpoint := flag.String("s3-endpoint", "", "S3 compatible endpoint")
	s3Region := flag.String("s3-region", "us-east-1", "S3 region")
	s3Prefix := flag.String("s3-prefix", "", "S3 object key prefix")
	publicBase := flag.String("public-url", "https://localhost:8443", "public HTTPS origin for asset links")
	mailBase := flag.String("mail-url", "", "origin for account emails (defaults to public-url)")
	tlsCert := flag.String("tls-cert", "", "TLS certificate file")
	tlsKey := flag.String("tls-key", "", "TLS key file")
	webDir := flag.String("web-dir", "", "built React web app directory")
	settingsKeyFile := flag.String("settings-key-file", "./data/settings.key", "persistent key for encrypted server settings")
	flag.Parse()

	if err := os.MkdirAll("./data", 0o750); err != nil {
		log.Fatalf("create data directory: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database, err := sqlite.Open(ctx, *databasePath)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer database.Close()
	if err := database.Migrate(ctx); err != nil {
		log.Fatalf("migrate database: %v", err)
	}
	var blobStore blob.Store
	if *s3Bucket != "" {
		blobStore, err = blob.NewS3Store(ctx, *s3Bucket, *s3Prefix, *s3Endpoint, *s3Region)
	} else {
		blobStore, err = blob.NewLocalStore(*blobRoot)
	}
	if err != nil {
		log.Fatalf("open blob store: %v", err)
	}
	repository := store.NewRepository(database, blobStore)
	settingsKey, err := loadSettingsKey(*settingsKeyFile)
	if err != nil {
		log.Fatalf("load settings key: %v", err)
	}
	if err := repository.SetSettingsKey(settingsKey); err != nil {
		log.Fatalf("configure settings key: %v", err)
	}

	if err := repository.SetPublicBase(*publicBase); err != nil {
		log.Fatal(err)
	}
	if *mailBase != "" {
		if err := repository.SetMailBase(*mailBase); err != nil {
			log.Fatal(err)
		}
	}
	initialized, err := repository.HasAdmin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if !initialized && os.Getenv("WENOTE_SETUP_TOKEN") == "" {
		path := filepath.Join(filepath.Dir(*databasePath), "setup.token")
		secret, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			key := make([]byte, 32)
			if _, err = rand.Read(key); err != nil {
				log.Fatal(err)
			}
			secret = []byte(hex.EncodeToString(key))
			err = writeNewSecret(path, secret)
		}
		if err != nil || len(strings.TrimSpace(string(secret))) < 32 {
			log.Fatal("cannot initialize setup token file")
		}
		os.Setenv("WENOTE_SETUP_TOKEN", strings.TrimSpace(string(secret)))
		log.Printf("GM setup token file: %s", path)
	}
	if _, err = database.ExecContext(ctx, `UPDATE backup_jobs SET status='failed',error='服务已重启',completed_at=? WHERE status='running'`, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		log.Fatal(err)
	}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if err := repository.RunDueBackup(ctx, now); err != nil {
					log.Printf("scheduled backup: %v", err)
				}
			}
		}
	}()
	repository.RunExports()
	mux := httpapi.NewMux(repository)
	if *webDir != "" {
		web := http.FileServer(http.Dir(*webDir))
		mux.Handle("GET /{$}", web)
		mux.Handle("GET /static/", web)
		mux.HandleFunc("GET /gm", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, *webDir+"/index.html")
		})
		mux.HandleFunc("GET /gm/", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, *webDir+"/index.html")
		})
	}
	server := &http.Server{
		Addr:              *address,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			log.Printf("shutdown server: %v", err)
		}
	}()

	log.Printf("WeNote API listening on %s", *address)
	if *tlsCert != "" || *tlsKey != "" {
		err = server.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve HTTP: %v", err)
	}
}

func loadSettingsKey(path string) ([]byte, error) {
	key, err := os.ReadFile(path)
	if err == nil {
		if len(key) != 32 {
			return nil, fmt.Errorf("settings key file must contain 32 bytes")
		}
		return key, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := writeNewSecret(path, key); err != nil {
		return nil, err
	}
	return key, nil
}

func writeNewSecret(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
