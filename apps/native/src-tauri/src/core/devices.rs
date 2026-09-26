use crate::core::crypto::sha256_hex;
use crate::core::id::unique_id;
use crate::core::RuntimeError;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CODE_TTL: u64 = 300;
const TOKEN_TTL: u64 = 30 * 24 * 3600;

pub struct DeviceStore {
    path: PathBuf,
    pending: Mutex<Option<(String, u64, u8)>>,
}

impl DeviceStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("devices.json"), pending: Mutex::new(None) }
    }

    pub fn new_code(&self) -> Result<String, RuntimeError> {
        let raw = unique_id("").bytes().fold(0u64, |a,b| a.wrapping_mul(131).wrapping_add(b as u64));
        let code = format!("{:06}", raw % 1_000_000);
        *self.pending.lock().map_err(|_| RuntimeError::new("LOCK_POISONED","设备配对锁已损坏"))? =
            Some((code.clone(), now()+CODE_TTL, 0));
        Ok(code)
    }

    pub fn pair(&self, code:&str, name:&str) -> Result<Option<String>,RuntimeError> {
        let mut pending=self.pending.lock().map_err(|_|RuntimeError::new("LOCK_POISONED","设备配对锁已损坏"))?;
        let Some((expected,expires,attempts))=pending.as_mut() else{return Ok(None);};
        if now()>*expires||*attempts>=5{*pending=None;return Ok(None);}
        *attempts+=1;
        if !constant_eq(code.as_bytes(),expected.as_bytes()){return Ok(None);}
        *pending=None;
        let token=format!("{}{}",unique_id(""),unique_id(""));
        let mut items=self.load();
        items.push(json!({
            "id":unique_id("").chars().take(8).collect::<String>(),
            "name":name.chars().take(60).collect::<String>(),
            "hash":sha256_hex(token.as_bytes()),
            "created":now(),
            "expires":now()+TOKEN_TTL,
            "last_seen":now()
        }));
        self.save(&items)?;
        Ok(Some(token))
    }

    pub fn verify(&self, token:&str)->Option<Value>{
        let hash=sha256_hex(token.as_bytes());
        self.load().into_iter().find(|d|
            d.get("hash").and_then(Value::as_str).is_some_and(|h|constant_eq(h.as_bytes(),hash.as_bytes()))
            && d.get("expires").and_then(Value::as_u64).is_some_and(|x|x>now())
        )
    }

    pub fn list(&self)->Vec<Value>{
        self.load().into_iter().map(|mut d|{
            if let Some(o)=d.as_object_mut(){o.remove("hash");}
            d
        }).collect()
    }

    pub fn revoke(&self,id:&str)->Result<bool,RuntimeError>{
        let mut items=self.load();
        let before=items.len();
        items.retain(|d|d.get("id").and_then(Value::as_str)!=Some(id));
        self.save(&items)?;
        Ok(items.len()!=before)
    }

    fn load(&self)->Vec<Value>{
        fs::read_to_string(&self.path).ok()
            .and_then(|s|serde_json::from_str::<Value>(&s).ok())
            .and_then(|v|v.as_array().cloned()).unwrap_or_default()
    }
    fn save(&self,items:&[Value])->Result<(),RuntimeError>{
        let tmp=self.path.with_extension("tmp");
        fs::write(&tmp,serde_json::to_vec_pretty(items).map_err(|e|RuntimeError::new("DEVICE_STORE",e.to_string()))?)
            .map_err(|e|RuntimeError::new("DEVICE_STORE",e.to_string()))?;
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp,fs::Permissions::from_mode(0o600)).map_err(|e|RuntimeError::new("DEVICE_STORE",e.to_string()))?;
        }
        #[cfg(windows)] if self.path.exists(){let _=fs::remove_file(&self.path);}
        fs::rename(tmp,&self.path).map_err(|e|RuntimeError::new("DEVICE_STORE",e.to_string()))
    }
}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn constant_eq(a:&[u8],b:&[u8])->bool{
    if a.len()!=b.len(){return false;}
    let mut diff=0u8;for(i,j)in a.iter().zip(b){diff|=*i^*j;}diff==0
}


#[cfg(test)]
mod tests {
    use super::DeviceStore;
    use std::fs;

    #[test]
    fn device_tokens_are_hashed_and_revocable() {
        let root=std::env::temp_dir().join(format!("diffusion-native-devices-{}",crate::core::id::unique_id("")));
        fs::create_dir_all(&root).unwrap();
        let store=DeviceStore::new(&root);
        let code=store.new_code().unwrap();
        let token=store.pair(&code,"phone").unwrap().unwrap();
        let raw=fs::read_to_string(root.join("devices.json")).unwrap();
        assert!(!raw.contains(&token));
        assert!(store.verify(&token).is_some());
        let id=store.list()[0]["id"].as_str().unwrap().to_owned();
        assert!(store.revoke(&id).unwrap());
        assert!(store.verify(&token).is_none());
        let _=fs::remove_dir_all(root);
    }
}
