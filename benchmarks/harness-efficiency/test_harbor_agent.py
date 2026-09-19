"""Dependency-contract tests; no Docker, provider calls, or Harbor install."""
import asyncio,importlib.util,json,shlex,sys,tempfile,types,unittest
from pathlib import Path

class FakeBase:
    def __init__(self,logs_dir,model_name=None,**kwargs):self.logs_dir=logs_dir;self.model_name=model_name;self.commands=[]
    async def exec_as_root(self,environment,command):return await self.exec_as_agent(environment,command)
    async def exec_as_agent(self,environment,command):self.commands.append(command);return types.SimpleNamespace(return_code=environment.code)
    async def _upload_config_text(self,environment,**kwargs):environment.config=kwargs['content']

class AdapterContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names=['harbor','harbor.agents','harbor.agents.installed','harbor.agents.installed.base'];cls.old={n:sys.modules.get(n) for n in names}
        for n in names:sys.modules[n]=types.ModuleType(n)
        m=sys.modules[names[-1]];m.BaseInstalledAgent=FakeBase;m.with_prompt_template=lambda f:f
        spec=importlib.util.spec_from_file_location('tested_adapter',Path(__file__).with_name('harbor_agent.py'));cls.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.module)
    @classmethod
    def tearDownClass(cls):
        for n,m in cls.old.items():
            if m is None:sys.modules.pop(n,None)
            else:sys.modules[n]=m
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.binary=self.root/'agent';self.binary.write_bytes(b'\x7fELFtest')
    def tearDown(self):self.tmp.cleanup()
    def make(self):return self.module.HandworkAgent(logs_dir=self.root,model_name='gateway/exact-model',provider_id='openrouter',binary_path=self.binary)
    def test_reject_macos_and_unspecified_provider(self):
        self.binary.write_bytes(b'not ELF')
        with self.assertRaises(ValueError):self.make()
        with self.assertRaises(ValueError):self.module.settings('codex','m','low')
    def test_install_records_identity_and_preserves_model_namespace(self):
        agent=self.make()
        class Env:
            code=0
            async def upload_file(self,source,target):self.upload=(source,target)
        env=Env();asyncio.run(agent.install(env));self.assertEqual(json.loads(env.config)['models']['openrouter'],'gateway/exact-model');self.assertEqual(json.loads((self.root/'handwork-build.json').read_text())['sha256'],agent.version())
    def test_prompt_is_one_literal_argument_and_failure_surfaces(self):
        agent=self.make();prompt="fix 'quotes'; $(touch /bad)\nsecond line"
        env=types.SimpleNamespace(code=0);asyncio.run(agent.run(prompt,env,None));parts=shlex.split(agent.commands[-1]);self.assertEqual(parts[6],prompt)
        env.code=7
        with self.assertRaises(RuntimeError):asyncio.run(agent.run(prompt,env,None))
    def test_usage_unknown_remains_unavailable(self):
        agent=self.make();context=types.SimpleNamespace(n_input_tokens=None,n_output_tokens=None,n_cache_tokens=None,cost_usd=None)
        agent.populate_context_post_run(context);self.assertIsNone(context.n_input_tokens)
        (self.root/'handwork.json').write_text(json.dumps({'usage':{'input_tokens':300,'output_tokens':20},'usage_details':{'cached_input_tokens':100}}))
        agent.populate_context_post_run(context);self.assertEqual((context.n_input_tokens,context.n_output_tokens,context.n_cache_tokens),(300,20,100));self.assertIsNone(context.cost_usd)
if __name__=='__main__':unittest.main()
