package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	tlsCert := flag.String("tls-cert", "", "TLS certificate file")
	tlsKey := flag.String("tls-key", "", "TLS key file")
	webDir := flag.String("web-dir", "", "built React web app directory")
	flag.Parse()

	if err := os.MkdirAll("./data", 0o750); err != nil {
		log.Fatalf("create data directory: %v", err)
	}
	ctx := context.Background()
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

	if err := repository.SetPublicBase(*publicBase); err != nil {
		log.Fatal(err)
	}
	repository.RunExports()
	mux := httpapi.NewMux(repository)
	if *webDir != "" {
		web := http.FileServer(http.Dir(*webDir))
		mux.Handle("GET /{$}", web)
		mux.Handle("GET /static/", web)
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
