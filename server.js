import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import fs from 'fs';
import cors from 'cors';

const app=express();
const upload=multer({dest:'tmp/'});
const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health',(req,res)=>res.json({ok:true,service:'Lamba Image Studio'}));

app.post('/api/generate',upload.single('image'),async(req,res)=>{
  if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:'На сервере не задан OPENAI_API_KEY.'});
  if(!req.file)return res.status(400).json({error:'Фото не загружено.'});
  const style=req.body.style||'современный образ';
  const userPrompt=req.body.prompt||'';
  const prompt=`Edit the supplied photo. Change only the person's clothing to a ${style}.
Preserve the same person, face/identity, pose, body position, camera angle, lighting and background as much as possible.
Do not add or remove people. Make the clothing realistic, tasteful and photorealistic.
User instructions: ${userPrompt}`;
  try{
    const result=await client.images.edit({
      model:'gpt-image-2',
      image:fs.createReadStream(req.file.path),
      prompt,
      size:'1024x1536',
      quality:'medium',
      output_format:'png'
    });
    res.json({image:result.data[0].b64_json});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e?.message||'Ошибка Image API'});
  }finally{fs.unlink(req.file.path,()=>{});}
});
app.listen(process.env.PORT||3000,()=>console.log('Lamba server started'));
