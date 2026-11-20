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

	"github.com/weifei/we-note/services/api/internal/httpapi"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

func main() {
	address := flag.String("addr", ":8080", "HTTP listen address")
	databasePath := flag.String("db", "./data/wenote.db", "SQLite database path")
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

	server := &http.Server{
		Addr:              *address,
		Handler:           httpapi.NewMux(),
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
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve HTTP: %v", err)
	}
}
