"""Handwork's native CLI in Harbor. Requires a prebuilt Linux ELF binary.

This adapter is a public-suite integration entry point, not a recorded score.
Pass explicit provider/model/effort and credentials through Harbor --agent-env.
"""
import hashlib
import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template


def validate_binary(path):
    binary=Path(path).expanduser().resolve()
    with binary.open('rb') as f:
        if f.read(4)!=b'\x7fELF':
            raise ValueError('Harbor task containers require a Linux ELF Handwork build, not the macOS npm binary')
    return binary


def settings(provider, model, effort):
    if provider not in ('openai','anthropic','openrouter'):
        raise ValueError('Use an explicit supported API provider: openai, anthropic, or openrouter')
    if not model or not effort:
        raise ValueError('Explicit model and effort are required for reproducibility')
    return {'provider':provider,'models':{provider:model},'effort':effort,'fast_mode':False,'yolo_acknowledged':True}


class HandworkAgent(BaseInstalledAgent):
    def __init__(self,*args,binary_path,provider_id,effort='low',**kwargs):
        self.binary_path=validate_binary(binary_path)
        self.provider_id=provider_id
        self.effort=effort
        super().__init__(*args,**kwargs)
        # Model ID is passed verbatim, including any gateway namespace.
        self.handwork_settings=settings(provider_id,self.model_name,effort)

    @staticmethod
    def name():return 'handwork-native'

    def version(self):
        return hashlib.sha256(self.binary_path.read_bytes()).hexdigest()

    async def install(self,environment):
        await environment.upload_file(self.binary_path,'/installed-agent/handwork')
        result=await self.exec_as_root(environment,command='chmod 755 /installed-agent/handwork')
        if result.return_code!=0:raise RuntimeError('Could not install Handwork binary')
        await self._upload_config_text(environment,content=json.dumps(self.handwork_settings),remote_path='/installed-agent/handwork-settings.json',filename='settings.json')
        # Only writes the disposable task container's profile. No host profile or
        # subscription credentials are copied into benchmark containers.
        result=await self.exec_as_agent(environment,command='mkdir -p "$HOME/.handwork" && cp /installed-agent/handwork-settings.json "$HOME/.handwork/settings.json"')
        if result.return_code!=0:raise RuntimeError('Could not configure task profile')
        self.logs_dir.mkdir(parents=True,exist_ok=True)
        (self.logs_dir/'handwork-build.json').write_text(json.dumps({'sha256':self.version(),'provider':self.provider_id,'model':self.model_name,'effort':self.effort},indent=2))

    @with_prompt_template
    async def run(self,instruction,environment,context):
        result=await self.exec_as_agent(environment,command='/installed-agent/handwork ask --full-access --json --no-save --no-color '+shlex.quote(instruction)+' > /logs/agent/handwork.json 2> /logs/agent/handwork.stderr')
        if result.return_code!=0:raise RuntimeError(f'Handwork exited with status {result.return_code}; inspect agent logs')

    def populate_context_post_run(self,context):
        path=self.logs_dir/'handwork.json'
        if not path.exists():return
        try:result=json.loads(path.read_text())
        except (ValueError,OSError):return
        usage={**(result.get('usage') or {}),**(result.get('usage_details') or {})}
        for field,key in [('n_input_tokens','input_tokens'),('n_output_tokens','output_tokens'),('n_cache_tokens','cached_input_tokens')]:
            value=usage.get(key)
            if isinstance(value,int) and not isinstance(value,bool) and value>=0:setattr(context,field,value)
        # Price is unknown unless an authoritative cost source is added.
