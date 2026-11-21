use anyhow::{bail, Context, Result};
use reqwest::blocking::{Client, Response};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub struct Api {
    client: Client,
    origin: String,
    token: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Remote {
    pub file_id: String,
    pub path: String,
    pub current_version_id: Option<String>,
    #[serde(default)]
    pub current_content_hash: String,
    pub is_deleted: bool,
}
#[derive(Deserialize)]
pub struct Manifest {
    pub snapshot_revision: u64,
    pub files: Vec<Remote>,
}
#[derive(Deserialize)]
pub struct Receipt {
    pub file_id: String,
    pub version_id: String,
    pub content_hash: String,
    pub path: String,
}
#[derive(Debug)]
pub struct HttpError(pub u16, String);
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}: {}", self.0, self.1)
    }
}
impl std::error::Error for HttpError {}
fn checked(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let error: Value = response.json().unwrap_or_default();
    Err(HttpError(
        status.as_u16(),
        error
            .pointer("/error/message")
            .or(error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("request failed")
            .to_owned(),
    )
    .into())
}
impl Api {
    pub fn new(origin: &str, token: &str) -> Result<Self> {
        let url = Url::parse(origin)?;
        if !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            bail!("请选择 HTTPS 服务地址，本地开发可用 http://localhost")
        };
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            origin: url.origin().ascii_serialization(),
            token: token.to_owned(),
        })
    }
    pub fn login(origin: &str, email: &str, password: &str) -> Result<String> {
        let response = Self::login_session(origin, email, password)?;
        Ok(response["access_token"]
            .as_str()
            .context("missing token")?
            .to_owned())
    }
    pub fn login_session(origin: &str, email: &str, password: &str) -> Result<Value> {
        Self::new(origin, "")?.json(
            Method::POST,
            "/api/v1/auth/login",
            Some(json!({"email":email,"password":password})),
            None,
        )
    }
    pub fn refresh(origin: &str, token: &str) -> Result<Value> {
        Self::new(origin, "")?.json(
            Method::POST,
            "/api/v1/auth/refresh",
            Some(json!({"refresh_token":token})),
            None,
        )
    }
    pub fn logout(&self) -> Result<()> {
        checked(
            self.client
                .post(format!("{}/api/v1/auth/logout", self.origin))
                .bearer_auth(&self.token)
                .send()?,
        )?;
        Ok(())
    }
    pub fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> Result<Value> {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            req = req.json(&body)
        }
        if let Some(key) = key {
            req = req.header("Idempotency-Key", key)
        }
        Ok(checked(req.send()?)?.json()?)
    }
    pub fn encrypted_vault(&self, id: Option<&str>, envelope: Option<Value>) -> Result<Value> {
        let mut route = String::from("/api/v1/encrypted-vaults");
        if let Some(id) = id {
            super::identifier(id)?;
            route.push('/');
            route.push_str(id);
        } else if envelope.is_some() {
            bail!("missing encrypted vault id")
        }
        self.json(
            if envelope.is_some() {
                Method::PUT
            } else {
                Method::GET
            },
            &route,
            envelope,
            None,
        )
    }
    pub fn vaults(&self) -> Result<Value> {
        self.json(Method::GET, "/api/v1/vaults", None, None)
    }
    pub fn device(&self) -> Result<String> {
        let v = self.json(
            Method::POST,
            "/api/v1/devices",
            Some(json!({"name":format!("WeNote {}",std::env::consts::OS)})),
            None,
        )?;
        Ok(v["id"].as_str().context("missing device")?.to_owned())
    }
    pub fn manifest(&self, vault: &str, device: &str) -> Result<Manifest> {
        let response = self
            .client
            .get(format!(
                "{}/api/v1/vaults/{vault}/sync/manifest",
                self.origin
            ))
            .header("X-Device-Id", device)
            .bearer_auth(&self.token)
            .send()?;
        Ok(checked(response)?.json()?)
    }
    pub fn version(&self, vault: &str, id: &str, version: &str, hash: &str) -> Result<Vec<u8>> {
        for field in [vault, id, version] {
            super::identifier(field)?
        }
        let response = self
            .client
            .get(format!(
                "{}/api/v1/vaults/{vault}/files/{id}/versions/{version}/content",
                self.origin
            ))
            .bearer_auth(&self.token)
            .send()?;
        let bytes = checked(response)?.bytes()?.to_vec();
        if super::digest(&bytes) != hash {
            bail!("download hash mismatch")
        };
        Ok(bytes)
    }
}

impl Api {
    pub(crate) fn asset_bytes(&self, vault: &str, id: &str) -> Result<(String, Vec<u8>)> {
        let meta = self.json(
            Method::GET,
            &format!("/api/v1/vaults/{vault}/assets/{id}"),
            None,
            None,
        )?;
        let response = checked(
            self.client
                .get(format!("{}/assets/{id}", self.origin))
                .bearer_auth(&self.token)
                .send()?,
        )?;
        let bytes = response.bytes()?;
        if Some(super::digest(&bytes).as_str()) != meta["content_hash"].as_str() {
            bail!("附件校验失败")
        };
        Ok((
            meta["media_type"]
                .as_str()
                .context("missing media type")?
                .into(),
            bytes.to_vec(),
        ))
    }
    pub(crate) fn upload_asset(
        &self,
        vault: &str,
        name: &str,
        media: &str,
        bytes: &[u8],
    ) -> Result<String> {
        let base = format!("/api/v1/vaults/{vault}/assets");
        let meta=self.json(Method::POST,&format!("{base}/uploads"),Some(json!({"name":name,"media_type":media,"content_hash":super::digest(bytes),"content_size":bytes.len()})),Some(&uuid::Uuid::new_v4().to_string()))?;
        let id = meta["asset_id"].as_str().context("missing asset ID")?;
        super::identifier(id)?;
        checked(
            self.client
                .post(format!("{}{base}/{id}/complete", self.origin))
                .bearer_auth(&self.token)
                .body(bytes.to_vec())
                .send()?,
        )?;
        Ok(meta["canonical_url"]
            .as_str()
            .context("missing asset URL")?
            .into())
    }
}

impl Api {
    pub(crate) fn copy_download(
        &self,
        route: &str,
        file: &mut std::fs::File,
        size: u64,
        hash: &str,
    ) -> Result<()> {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Write};
        let mut response = checked(
            self.client
                .get(format!("{}{route}", self.origin))
                .bearer_auth(&self.token)
                .send()?,
        )?
        .take(size.saturating_add(1));
        let mut buffer = [0; 32768];
        let mut digest = Sha256::new();
        let mut total = 0u64;
        loop {
            let n = response.read(&mut buffer)?;
            if n == 0 {
                break;
            };
            file.write_all(&buffer[..n])?;
            digest.update(&buffer[..n]);
            total += n as u64
        }
        if total != size || format!("sha256:{:x}", digest.finalize()) != hash {
            bail!("下载内容校验失败")
        };
        file.sync_all()?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum AssetTransfer {
    User,
    Create {
        meta: Value,
        key: String,
    },
    Parts {
        id: String,
    },
    Put {
        id: String,
        number: u32,
        range: String,
        hash: String,
        data: String,
    },
    Assemble {
        id: String,
    },
}
impl Api {
    pub fn transfer(&self, vault: &str, request: AssetTransfer) -> Result<Value> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use AssetTransfer::*;
        super::identifier(vault)?;
        let base = format!("/api/v1/vaults/{vault}/assets");
        match request {
            User => self.json(Method::GET, "/api/v1/me", None, None),
            Create { meta, key } => self.json(
                Method::POST,
                &format!("{base}/uploads"),
                Some(meta),
                Some(&key),
            ),
            Parts { id } => {
                super::identifier(&id)?;
                self.json(Method::GET, &format!("{base}/{id}/parts"), None, None)
            }
            Put {
                id,
                number,
                range,
                hash,
                data,
            } => {
                super::identifier(&id)?;
                checked(
                    self.client
                        .put(format!("{}{base}/{id}/parts/{number}", self.origin))
                        .bearer_auth(&self.token)
                        .header("Content-Range", range)
                        .header("X-Part-Hash", hash)
                        .body(STANDARD.decode(data)?)
                        .send()?,
                )?;
                Ok(Value::Null)
            }
            Assemble { id } => {
                super::identifier(&id)?;
                checked(
                    self.client
                        .post(format!("{}{base}/{id}/assemble", self.origin))
                        .bearer_auth(&self.token)
                        .send()?,
                )?;
                Ok(Value::Null)
            }
        }
    }
    pub fn devices(&self, remove: Option<&str>) -> Result<Value> {
        if let Some(id) = remove {
            super::identifier(id)?;
            checked(
                self.client
                    .delete(format!("{}/api/v1/devices/{id}", self.origin))
                    .bearer_auth(&self.token)
                    .send()?,
            )?;
        }
        self.json(Method::GET, "/api/v1/devices", None, None)
    }
}
